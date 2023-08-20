import { Filter, TagQueryKey } from "./deps.ts";
import { NostrEvent } from "./event.ts";

export const matchEventWithFilter = (ev: NostrEvent, f: Filter): boolean => {
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

export const matchEventWithFilters = (
  ev: NostrEvent,
  filters: Filter[],
): boolean => filters.some((f) => matchEventWithFilter(ev, f));

const matchWithTagQuery = (ev: NostrEvent, f: Filter): boolean => {
  const tagQueryKeys = Object.keys(f).filter(isTagQueryKey);
  if (tagQueryKeys.length === 0) {
    // fast path: filter doesn't have any tag queries
    return true;
  }

  return tagQueryKeys.every((tqk) => {
    const tagVals = getTagValuesByName(ev, tqk.charAt(1));
    const queryVals = f[tqk] as string[];
    return queryVals.some((qv) => tagVals.has(qv));
  });
};

const getTagValuesByName = (ev: NostrEvent, tagName: string): Set<string> =>
  new Set(ev.tags.filter((t) => t[0] === tagName).map((t) => t[1] ?? ""));

// checks if `s` has the pattern of tag query key (e.g. "#" + single letter)
const isTagQueryKey = (s: string): s is TagQueryKey => {
  return s.startsWith("#") && s.length === 2;
};

export const isReqFilter = (raw: Record<string, unknown>): raw is Filter => {
  if ("ids" in raw && !Array.isArray(raw.ids)) {
    return false;
  }
  if ("kinds" in raw && !Array.isArray(raw.kinds)) {
    return false;
  }
  if ("authors" in raw && !Array.isArray(raw.authors)) {
    return false;
  }
  if ("since" in raw && typeof raw.since !== "number") {
    return false;
  }
  if ("until" in raw && typeof raw.until !== "number") {
    return false;
  }
  if ("limit" in raw && typeof raw.limit !== "number") {
    return false;
  }
  if ("search" in raw && typeof raw.search !== "string") {
    return false;
  }
  for (const tqk of Object.keys(raw).filter((k) => isTagQueryKey(k))) {
    if (!Array.isArray(raw[tqk])) {
      return false;
    }
  }

  return true;
};
