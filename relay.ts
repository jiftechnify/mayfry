import { Filter, NostrEvent, ToRelayMessage } from "./deps.ts";
import { matchEventWithFilters } from "./match_filter.ts";
import { Result } from "./types.ts";

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
    const strAddr = addrToString(remoteAddr)

    const rs = new RelaySocket(this, ws, strAddr);
    ws.addEventListener("open", () => {
      console.log(`websocket opened. remote addr: ${strAddr}`);
    });
    ws.addEventListener("close", (ev) => {
      console.log(
        `websocket closed. remote addr: ${strAddr}, code: ${
          ev.code
        }, reason: ${ev.reason}`
      );
      this.#sockets.delete(rs);
    });
    ws.addEventListener("error", (ev) => {
      console.log(`websocket error. remote addr: ${strAddr}, error: ${JSON.stringify(ev)}`);
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
      const parseRes = parseMessage(ev.data);
      if (!parseRes.isOk) {
        console.error("failed to parse message from client", parseRes.err);
        // TODO: send NOTICE
        return;
      }
      switch (parseRes.val[0]) {
        case "EVENT": {
          const [, ev] = parseRes.val;
          // TODO: validate format and signature
          console.log(`received event from ${this.#remoteAddr}`)
          this.#server.broadcastEvent(this, ev as unknown as NostrEvent);
          break;
        }
        case "REQ": {
          const [, subId, ...filters] = parseRes.val;
          // TODO: validate format

          // start subscription
          console.log(`opening subscription. remote addr: ${this.#remoteAddr}, id: ${subId}`)
          this.#subs.set(subId, filters as unknown as Filter[]);
          
          // return EOSE immediately since this relay dosen't sore any events
          this.sendEose(subId);
          break;
        }
        case "CLOSE": {
          const [, subId] = parseRes.val;
          // TODO: should send NOTICE if there is no subscription of specified id?
          console.log(`closing subscription. remote addr: ${this.#remoteAddr}, id: ${subId}`)
          this.#subs.delete(subId);
          break;
        }
      }
    });
  }

  private sendEvent(subId: string, ev: NostrEvent) {
    const msg = ["EVENT", subId, ev];
    this.#ws.send(JSON.stringify(msg));
  }

  private sendEose(subId: string) {
    const msg = ["EOSE", subId];
    this.#ws.send(JSON.stringify(msg));
  }

  broadcastEvent(ev: NostrEvent) {
    for (const [subId, filters] of this.#subs) {
      if (matchEventWithFilters(ev, filters)) {
        this.sendEvent(subId, ev);
      }
    }
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
  | [type: "EVENT", ev: Record<string, unknown>]
  | [type: "REQ", subId: string, ...filters: Record<string, unknown>[]]
  | [type: "CLOSE", subId: string];

type ParseMessageError =
  | { err: "malformed" }
  | { err: "unsupported"; msgType: string };

const parseMessage = (s: string): Result<C2RMessage, ParseMessageError> => {
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
      if (!isRecord(parsed[1])) {
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
      if (parsed.slice(2).some(f => !isRecord(f))) {
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
