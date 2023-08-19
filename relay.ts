import { Filter, ToRelayMessage, verifyEventSignature } from "./deps.ts";
import { matchEventWithFilters } from "./match_filter.ts";
import { NostrEvent, Result } from "./types.ts";

export const launchRelay = async () => {
  const relayServer = new RelayServer();

  const handleConn = async (conn: Deno.Conn) => {
    const httpConn = Deno.serveHttp(conn);
    const reqEv = await httpConn.nextRequest();
    if (reqEv) {
      const { socket, response } = Deno.upgradeWebSocket(reqEv.request);

      relayServer.addSocket(socket, conn.remoteAddr);

      reqEv.respondWith(response);
    }
  };

  // TODO: make configurable the port to listen
  console.log("relay listening on :8081...");
  const tcpServer = Deno.listen({ port: 8081 });
  for await (const conn of tcpServer) {
    handleConn(conn);
  }
};

export class RelayServer {
  #sockets: Set<RelaySocket> = new Set();

  addSocket(ws: WebSocket, remoteAddr: Deno.Addr) {
    const strAddr = addrToString(remoteAddr);

    const rs = new RelaySocket(this, ws, strAddr);
    ws.addEventListener("open", () => {
      console.log(`websocket opened. remote addr: ${strAddr}`);
    });
    ws.addEventListener("close", (ev) => {
      console.log(
        `websocket closed. remote addr: ${strAddr}, code: ${ev.code}, reason: ${ev.reason}`
      );
      this.#sockets.delete(rs);
    });
    ws.addEventListener("error", (ev) => {
      console.log(
        `websocket error. remote addr: ${strAddr}, error: ${JSON.stringify(ev)}`
      );
    });

    this.#sockets.add(rs);
  }

  broadcastEvent(sender: RelaySocket, ev: NostrEvent) {
    for (const s of this.#sockets) {
      if (sender !== s) {
        s.broadcastEvent(ev);
      }
    }
  }
}

class RelaySocket {
  #server: RelayServer;
  #ws: WebSocket;
  #remoteAddr: string;

  #subs: Map<string, Filter[]> = new Map();

  constructor(server: RelayServer, ws: WebSocket, remoteAddr: string) {
    this.#server = server;
    this.#ws = ws;
    this.#remoteAddr = remoteAddr;

    ws.addEventListener("message", (ev: MessageEvent<string>) => {
      const parseRes = parseC2RMessage(ev.data);
      if (!parseRes.isOk) {
        console.error("failed to parse message from client", parseRes.err);
        
        let notice: string
        switch (parseRes.err.err) {
          case 'malformed':
            notice = "malformed client to relay message"
            break;
          case 'unsupported':
            notice = `message type ${parseRes.err.msgType} is not supported by this relay`
            break;
        }
        this.sendR2CMsg([
          "NOTICE",
          notice
        ])
        return;
      }
      
      switch (parseRes.val[0]) {
        case "EVENT": {
          const [, ev] = parseRes.val;

          console.log(`received event from ${this.#remoteAddr}`);

          if (ev.kind < 20000 || 30000 <= ev.kind) {
            this.sendR2CMsg([
              "OK",
              ev.id,
              false,
              "blocked: this relay accepts ephemeral events only",
            ]);
            return;
          }
          if (!verifyEventSignature(ev)) {
            this.sendR2CMsg([
              "OK",
              ev.id,
              false,
              "invalid: invalid event signature",
            ]);
            return;
          }

          this.#server.broadcastEvent(this, ev as unknown as NostrEvent);
          this.sendR2CMsg(["OK", ev.id, true]);
          break;
        }
        case "REQ": {
          const [, subId, ...filters] = parseRes.val;
          // TODO: validate format

          // start subscription
          console.log(
            `opening subscription. remote addr: ${
              this.#remoteAddr
            }, id: ${subId}`
          );
          this.#subs.set(subId, filters as unknown as Filter[]);

          // return EOSE immediately since this relay dosen't sore any events
          this.sendR2CMsg(["EOSE", subId]);
          break;
        }
        case "CLOSE": {
          const [, subId] = parseRes.val;
          // TODO: should send NOTICE if there is no subscription of specified id?
          console.log(
            `closing subscription. remote addr: ${
              this.#remoteAddr
            }, id: ${subId}`
          );
          this.#subs.delete(subId);
          break;
        }
      }
    });
  }

  broadcastEvent(ev: NostrEvent) {
    for (const [subId, filters] of this.#subs) {
      if (matchEventWithFilters(ev, filters)) {
        this.sendR2CMsg(["EVENT", subId, ev]);
      }
    }
  }

  private sendR2CMsg(msg: R2CMessage) {
    this.#ws.send(JSON.stringify(msg));
  }
}

const c2rMsgNames: ToRelayMessage.Type[] = [
  "EVENT",
  "REQ",
  "CLOSE",
  "AUTH",
  "COUNT",
];
const isC2RMsgName = (s: string): s is ToRelayMessage.Type =>
  (c2rMsgNames as string[]).includes(s);

const supportedC2RMsgNames = ["EVENT", "REQ", "CLOSE"];
const isSupportedC2RMsgName = (
  s: ToRelayMessage.Type
): s is "EVENT" | "REQ" | "CLOSE" => supportedC2RMsgNames.includes(s);

type C2RMessage =
  | [type: "EVENT", ev: NostrEvent]
  | [type: "REQ", subId: string, ...filters: Record<string, unknown>[]]
  | [type: "CLOSE", subId: string];

type ParseC2RMessageError =
  | { err: "malformed" }
  | { err: "unsupported"; msgType: string };

const parseC2RMessage = (
  s: string
): Result<C2RMessage, ParseC2RMessageError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s) as unknown;
  } catch (err) {
    console.error(err);
    return Result.err({ err: "malformed" });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    typeof parsed[0] !== "string"
  ) {
    return Result.err({ err: "malformed" });
  }

  if (!isC2RMsgName(parsed[0])) {
    return Result.err({ err: "malformed" });
  }
  if (!isSupportedC2RMsgName(parsed[0])) {
    return Result.err({ err: "unsupported", msgType: parsed[0] });
  }

  switch (parsed[0]) {
    case "EVENT": {
      if (parsed.length !== 2) {
        return Result.err({ err: "malformed" });
      }
      if (!isNostrEvent(parsed[1])) {
        return Result.err({ err: "malformed" });
      }
      return Result.ok(parsed as C2RMessage);
    }
    case "REQ": {
      if (parsed.length < 3) {
        return Result.err({ err: "malformed" });
      }
      if (typeof parsed[1] !== "string") {
        return Result.err({ err: "malformed" });
      }
      if (parsed.slice(2).some((f) => !isRecord(f))) {
        return Result.err({ err: "malformed" });
      }
      return Result.ok(parsed as C2RMessage);
    }
    case "CLOSE": {
      if (parsed.length !== 2) {
        return Result.err({ err: "malformed" });
      }
      if (typeof parsed[1] !== "string") {
        return Result.err({ err: "malformed" });
      }
      return Result.ok(parsed as C2RMessage);
    }
  }
};

const regexp32BytesHexStr = /^[a-f0-9]{64}$/;
const regexp64BytesHexStr = /^[a-f0-9]{128}$/;

const is32BytesHexStr = (s: string): boolean => {
  return regexp32BytesHexStr.test(s);
};

const is64BytesHexStr = (s: string): boolean => {
  return regexp64BytesHexStr.test(s);
};

// schema validation for Nostr events
export const isNostrEvent = (
  rawEv: Record<string, unknown>
): rawEv is NostrEvent => {
  // id: 32-bytes lowercase hex-encoded sha256
  if (
    !("id" in rawEv) ||
    typeof rawEv["id"] !== "string" ||
    !is32BytesHexStr(rawEv["id"])
  ) {
    return false;
  }

  // pubkey: 32-bytes lowercase hex-encoded public key
  if (
    !("pubkey" in rawEv) ||
    typeof rawEv["pubkey"] !== "string" ||
    !is32BytesHexStr(rawEv["pubkey"])
  ) {
    return false;
  }

  // created_at: unix timestamp in seconds
  if (!("created_at" in rawEv) || typeof rawEv["created_at"] !== "number") {
    return false;
  }

  // kind: integer
  if (!("kind" in rawEv) || typeof rawEv["kind"] !== "number") {
    return false;
  }

  // tags: array of arrays of non-null strings
  if (!("tags" in rawEv) || !Array.isArray(rawEv["tags"])) {
    return false;
  }
  if (
    rawEv["tags"].some(
      (tag) => !Array.isArray(tag) || tag.some((e) => typeof e !== "string")
    )
  ) {
    return false;
  }

  // content: string
  if (!("content" in rawEv) || typeof rawEv["content"] !== "string") {
    return false;
  }

  // sig: 64-bytes hex of the signature
  if (
    !("sig" in rawEv) ||
    typeof rawEv["sig"] !== "string" ||
    !is64BytesHexStr(rawEv["sig"])
  ) {
    return false;
  }

  return true;
};

type R2CMessage =
  | [type: "EVENT", subId: string, ev: NostrEvent]
  | [type: "OK", evId: string, accepted: boolean, msg?: string]
  | [type: "EOSE", subId: string]
  | [type: "NOTICE", msg: string];

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && !Array.isArray(x);

const addrToString = (addr: Deno.Addr): string => {
  switch (addr.transport) {
    case "tcp":
    case "udp":
      return `${addr.transport}:${addr.hostname}:${addr.port}`;

    case "unix":
    case "unixpacket":
      return `${addr.transport}:${addr.path}`;
  }
};
