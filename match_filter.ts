import { Filter, NostrEvent } from "./deps.ts";

const matchEvent = (
  ev: NostrEvent,
  f: Filter,
  ): boolean => {
  // TODO: use Set to reduce complexity
  if (f.kinds !== undefined && !f.kinds.includes(ev.kind)) {
    return false;
  }
  if (f.authors !== undefined && !f.authors.includes(ev.pubkey)) {
    return false;
  }
  if (!matchWithTagQuery(ev, f)) {
    return false;
  }

  // conditions that seem uncommon for subscribing ephemeral events
  if (f.since !== undefined && ev.created_at < f.since) {
    return false;
  }
  if (f.until !== undefined && ev.created_at > f.until) {
    return false;
  }
  if (f.ids !== undefined && !f.ids.includes(ev.id)) {
    return false;
  }
  
  return true;
};

const matchWithTagQuery = (
  ev: NostrEvent,
  f: Filter
): boolean => {
  // TODO
  return true
}
