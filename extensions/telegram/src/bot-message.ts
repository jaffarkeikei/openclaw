import type { ReplyToMode } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";

/** Dependencies injected once when creating the message processor. */
type TelegramMessageProcessorDeps = Omit<
  BuildTelegramMessageContextParams,
  "primaryCtx" | "allMedia" | "storeAllowFrom" | "options"
> & {
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramDeps: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token">;
};

export const createTelegramMessageProcessor = (deps: TelegramMessageProcessorDeps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    loadFreshConfig,
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    telegramDeps,
    opts,
  } = deps;

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: TelegramMessageContextOptions,
    replyMedia?: TelegramMediaRef[],
  ) => {
    const ingressReceivedAtMs =
      typeof options?.receivedAtMs === "number" && Number.isFinite(options.receivedAtMs)
        ? options.receivedAtMs
        : undefined;
    const ingressDebugEnabled =
      shouldLogVerbose() || process.env.OPENCLAW_DEBUG_TELEGRAM_INGRESS === "1";
    const ingressContextStartMs = ingressReceivedAtMs ? Date.now() : undefined;
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      replyMedia,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
      sendChatActionHandler,
      loadFreshConfig,
      upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
    });
    if (!context) {
      if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
        logVerbose(
          `telegram ingress: chatId=${primaryCtx.message.chat.id} dropped after ${Date.now() - ingressReceivedAtMs}ms` +
            `${options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""}`,
        );
      }
      return;
    }

    // If messageForwardUrl is set, forward the DM to an external handler (e.g. Snowball) instead of
    // running the local agent. The handler receives the raw message and returns a reply.
    const messageForwardUrl = telegramCfg.messageForwardUrl?.trim();
    if (messageForwardUrl && !context.isGroup) {
      const text =
        typeof context.ctxPayload.BodyForAgent === "string"
          ? context.ctxPayload.BodyForAgent.trim()
          : "";
      if (text) {
        try {
          // Show "typing..." indicator while the external handler processes the message
          sendChatActionHandler.sendChatAction(context.chatId, "typing").catch(() => {});

          const forwardSecret = telegramCfg.messageForwardSecret?.trim() ?? null;
          const reqHeaders: Record<string, string> = { "Content-Type": "application/json" };
          if (forwardSecret) {
            reqHeaders["x-forward-secret"] = forwardSecret;
          }

          const forwardRes = await fetch(messageForwardUrl, {
            method: "POST",
            headers: reqHeaders,
            body: JSON.stringify({
              channel: "telegram",
              channelUserId: String(context.msg.from?.id ?? context.chatId),
              text,
              sessionKey: context.route.sessionKey,
            }),
            signal: AbortSignal.timeout(30_000),
          });

          if (!forwardRes.ok) {
            throw new Error(`Forward handler returned ${forwardRes.status}`);
          }
          const forwardBody = (await forwardRes.json()) as { reply?: string; error?: string };
          if (!forwardBody.reply) {
            throw new Error(forwardBody.error ?? "No reply returned from forward handler");
          }

          await bot.api.sendMessage(
            context.chatId,
            forwardBody.reply,
            context.threadSpec?.id != null
              ? { message_thread_id: context.threadSpec.id }
              : undefined,
          );
        } catch (err) {
          runtime.error?.(danger(`telegram: message forward failed: ${String(err)}`));
        }
        return;
      }
    }

    if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
      logVerbose(
        `telegram ingress: chatId=${context.chatId} contextReadyMs=${Date.now() - ingressReceivedAtMs}` +
          ` preDispatchMs=${Date.now() - ingressContextStartMs}` +
          `${options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""}`,
      );
    }
    try {
      await dispatchTelegramMessage({
        context,
        bot,
        cfg,
        runtime,
        replyToMode,
        streamMode,
        textLimit,
        telegramCfg,
        telegramDeps,
        opts,
      });
      if (ingressDebugEnabled && ingressReceivedAtMs) {
        logVerbose(
          `telegram ingress: chatId=${context.chatId} dispatchCompleteMs=${Date.now() - ingressReceivedAtMs}` +
            `${options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""}`,
        );
      }
    } catch (err) {
      runtime.error?.(danger(`telegram message processing failed: ${String(err)}`));
      try {
        await bot.api.sendMessage(
          context.chatId,
          "Something went wrong while processing your request. Please try again.",
          context.threadSpec?.id != null ? { message_thread_id: context.threadSpec.id } : undefined,
        );
      } catch {
        // Best-effort fallback; delivery may fail if the bot was blocked or the chat is invalid.
      }
    }
  };
};
