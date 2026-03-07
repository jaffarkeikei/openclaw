import type { PairingChannel } from "./pairing-store.js";

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
}): string {
  const { idLine, code } = params;
  return [
    "Welcome! Your account isn't paired yet.",
    "",
    idLine,
    "",
    `Pairing code: ${code}`,
    "",
    "Enter your user ID and pairing code in the Anza dashboard to connect.",
  ].join("\n");
}
