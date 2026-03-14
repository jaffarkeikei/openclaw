import type { ReplyToMode } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.telegram.js";
import { danger } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
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
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
  } = deps;

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: { messageIdOverride?: string; forceWasMentioned?: boolean },
    replyMedia?: TelegramMediaRef[],
  ) => {
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
    });
    if (!context) {
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
          const forwardSecret = telegramCfg.messageForwardSecret?.trim() ?? null;
          const reqHeaders: Record<string, string> = { "Content-Type": "application/json" };
          if (forwardSecret) reqHeaders["x-forward-secret"] = forwardSecret;

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
            context.threadSpec?.id != null ? { message_thread_id: context.threadSpec.id } : undefined,
          );
        } catch (err) {
          runtime.error?.(danger(`telegram: message forward failed: ${String(err)}`));
        }
        return;
      }
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
        opts,
      });
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
