/**
 * HTTP endpoint for sending outbound messages via the gateway.
 *
 * POST /v1/messages/send
 *
 * Provides the same functionality as the WebSocket `send` RPC method but over
 * plain HTTP, making it usable from external services (e.g. Cloud Run) that
 * cannot maintain a persistent WebSocket connection.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { loadConfig } from "../config/config.js";
import { resolveOutboundChannelPlugin } from "../infra/outbound/channel-resolution.js";
import { resolveMessageChannelSelection } from "../infra/outbound/channel-selection.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import {
  resolveOutboundSessionRoute,
  ensureOutboundSessionEntry,
} from "../infra/outbound/outbound-session.js";
import { normalizeReplyPayloadsForDelivery } from "../infra/outbound/payloads.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { maybeResolveIdLikeTarget } from "../infra/outbound/target-resolver.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";

const MESSAGES_SEND_PATH = "/v1/messages/send";
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

type MessagesSendHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type SendRequestBody = {
  to?: unknown;
  message?: unknown;
  channel?: unknown;
  accountId?: unknown;
  agentId?: unknown;
  threadId?: unknown;
  sessionKey?: unknown;
  idempotencyKey?: unknown;
};

export async function handleMessagesSendHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MessagesSendHttpOptions,
): Promise<boolean> {
  const result = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: MESSAGES_SEND_PATH,
    auth: opts.auth,
    maxBodyBytes: MAX_BODY_BYTES,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });

  // false = not our route, undefined = already replied (auth fail / bad method)
  if (result === false) {
    return false;
  }
  if (result === undefined) {
    return true;
  }

  const params = (result.body ?? {}) as SendRequestBody;

  const to = typeof params.to === "string" ? params.to.trim() : "";
  const message = typeof params.message === "string" ? params.message.trim() : "";
  const channelInput = typeof params.channel === "string" ? params.channel.trim() : "";
  const accountId =
    typeof params.accountId === "string" && params.accountId.trim()
      ? params.accountId.trim()
      : undefined;
  const threadId =
    typeof params.threadId === "string" && params.threadId.trim()
      ? params.threadId.trim()
      : undefined;
  const sessionKey =
    typeof params.sessionKey === "string" && params.sessionKey.trim()
      ? params.sessionKey.trim().toLowerCase()
      : undefined;
  const explicitAgentId =
    typeof params.agentId === "string" && params.agentId.trim() ? params.agentId.trim() : undefined;
  const idempotencyKey =
    typeof params.idempotencyKey === "string" && params.idempotencyKey.trim()
      ? params.idempotencyKey.trim()
      : randomUUID();

  if (!to) {
    sendJson(res, 400, { ok: false, error: '"to" (target) is required' });
    return true;
  }

  if (!message) {
    sendJson(res, 400, { ok: false, error: '"message" is required' });
    return true;
  }

  // Resolve channel
  const normalizedChannel = channelInput ? normalizeChannelId(channelInput) : null;
  if (channelInput && !normalizedChannel) {
    sendJson(res, 400, { ok: false, error: `unsupported channel: ${channelInput}` });
    return true;
  }

  const cfg = loadConfig();
  let channel = normalizedChannel;
  if (!channel) {
    try {
      channel = (await resolveMessageChannelSelection({ cfg })).channel;
    } catch (err) {
      sendJson(res, 400, { ok: false, error: `cannot resolve channel: ${String(err)}` });
      return true;
    }
  }

  const plugin = resolveOutboundChannelPlugin({ channel, cfg });
  if (!plugin) {
    sendJson(res, 400, { ok: false, error: `unsupported channel: ${channel}` });
    return true;
  }

  try {
    const resolved = resolveOutboundTarget({
      channel,
      to,
      cfg,
      accountId,
      mode: "explicit",
    });
    if (!resolved.ok) {
      sendJson(res, 400, { ok: false, error: String(resolved.error) });
      return true;
    }

    const idLikeTarget = await maybeResolveIdLikeTarget({
      cfg,
      channel,
      input: resolved.to,
      accountId,
    });
    const deliveryTarget = idLikeTarget?.to ?? resolved.to;

    const mirrorPayloads = normalizeReplyPayloadsForDelivery([{ text: message }]);
    const mirrorText = mirrorPayloads
      .map((p) => p.text)
      .filter(Boolean)
      .join("\n");

    const sessionAgentId = sessionKey
      ? resolveSessionAgentId({ sessionKey, config: cfg })
      : undefined;
    const defaultAgentId = resolveSessionAgentId({ config: cfg });
    const effectiveAgentId = explicitAgentId ?? sessionAgentId ?? defaultAgentId;

    const derivedRoute = !sessionKey
      ? await resolveOutboundSessionRoute({
          cfg,
          channel,
          agentId: effectiveAgentId,
          accountId,
          target: deliveryTarget,
          resolvedTarget: idLikeTarget,
          threadId,
        })
      : null;

    if (derivedRoute) {
      await ensureOutboundSessionEntry({
        cfg,
        agentId: effectiveAgentId,
        channel,
        accountId,
        route: derivedRoute,
      });
    }

    const outboundSession = buildOutboundSessionContext({
      cfg,
      agentId: effectiveAgentId,
      sessionKey: sessionKey ?? derivedRoute?.sessionKey,
    });

    const results = await deliverOutboundPayloads({
      cfg,
      channel,
      to: deliveryTarget,
      accountId,
      payloads: [{ text: message }],
      session: outboundSession,
      threadId: threadId ?? null,
      mirror: sessionKey
        ? {
            sessionKey,
            agentId: effectiveAgentId,
            text: mirrorText || message,
            idempotencyKey,
          }
        : derivedRoute
          ? {
              sessionKey: derivedRoute.sessionKey,
              agentId: effectiveAgentId,
              text: mirrorText || message,
              idempotencyKey,
            }
          : undefined,
    });

    const last = results.at(-1);
    if (!last) {
      sendJson(res, 500, { ok: false, error: "no delivery result" });
      return true;
    }

    const payload: Record<string, unknown> = {
      ok: true,
      runId: idempotencyKey,
      messageId: last.messageId,
      channel,
    };
    if ("chatId" in last) {
      payload.chatId = last.chatId;
    }
    if ("channelId" in last) {
      payload.channelId = last.channelId;
    }
    if ("toJid" in last) {
      payload.toJid = last.toJid;
    }
    if ("conversationId" in last) {
      payload.conversationId = last.conversationId;
    }

    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 502, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return true;
}
