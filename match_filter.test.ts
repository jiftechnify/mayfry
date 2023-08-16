import { Filter } from "./deps.ts";
import { assert } from "./dev_deps.ts";
import { matchEventWithFilter } from "./match_filter.ts";

const ev = {
  id: "id1",
  pubkey: "pk1",
  created_at: 1629123456,
  kind: 1,
  tags: [
    ["e", "e1"],
    ["p", "p1"],
  ],
  content: "",
  sig: "sig",
};

Deno.test("matchEventWithFilter", async (t) => {
  await t.step("should return true when event matches the filter", () => {
    const filters: Filter[] = [
      {},
      { ids: ["id1"] },
      { ids: ["id1", "id2"] },
      { kinds: [1] },
      { kinds: [1, 2] },
      { authors: ["pk1"] },
      { authors: ["pk1", "pk2"] },
      { "#e": ["e1"] },
      { "#e": ["e1", "e2"] },
      { "#p": ["p1"] },
      { "#p": ["p1", "p2"] },
      { since: 1629000000, until: 1630000000 },
      { since: 1629000000 },
      { since: 1629123456 }, // matches if since == created_at
      { until: 1630000000 },
      { until: 1629123456 }, // matches if until == created_at
      {
        ids: ["id1"],
        kinds: [1],
        authors: ["pk1"],
        "#e": ["e1"],
        "#p": ["p1"],
        since: 1629000000,
        until: 1630000000,
      },
    ];

    for (const f of filters) {
      assert(matchEventWithFilter(ev, f), `filter: ${JSON.stringify(f)}`);
    }
  });

  await t.step(
    "should return false when event does not match the filter",
    () => {
      const filters: Filter[] = [
        { ids: ["id2"] },
        { ids: ["id2", "id3"] },
        { kinds: [2] },
        { kinds: [2, 3] },
        { authors: ["pk2"] },
        { authors: ["pk2", "pk3"] },
        { "#e": ["e2"] },
        { "#e": ["e2", "e3"] },
        { "#p": ["p2"] },
        { "#p": ["p2", "p3"] },
        { "#a": ["a1"] }, // missing tag
        { since: 1630000000 },
        { until: 1629000000 },
        // matches except one filter...
        {
          ids: ["id2"], // mismatch
          kinds: [1],
          authors: ["pk1"],
          "#e": ["e1"],
          "#p": ["p1"],
          since: 1629000000,
          until: 1630000000,
        },
        {
          ids: ["id1"],
          kinds: [2], // mismatch
          authors: ["pk1"],
          "#e": ["e1"],
          "#p": ["p1"],
          since: 1629000000,
          until: 1630000000,
        },
        {
          ids: ["id1"],
          kinds: [1],
          authors: ["pk2"], // mismatch
          "#e": ["e1"],
          "#p": ["p1"],
          since: 1629000000,
          until: 1630000000,
        },
        {
          ids: ["id1"],
          kinds: [1],
          authors: ["pk1"],
          "#e": ["e2"], // mismatch
          "#p": ["p1"],
          since: 1629000000,
          until: 1630000000,
        },
        {
          ids: ["id1"],
          kinds: [1],
          authors: ["pk1"],
          "#e": ["e1"],
          "#p": ["p2"], // mismatch
          since: 1629000000,
          until: 1630000000,
        },
        {
          ids: ["id1"],
          kinds: [1],
          authors: ["pk1"],
          "#e": ["e1"],
          "#p": ["p1"],
          "#a": ["a1"], // missing tag
          since: 1629000000,
          until: 1630000000,
        },
        {
          ids: ["id1"],
          kinds: [1],
          authors: ["pk1"],
          "#e": ["e1"],
          "#p": ["p1"],
          since: 1630000000, // mismatch
        },
        {
          ids: ["id1"],
          kinds: [1],
          authors: ["pk1"],
          "#e": ["e1"],
          "#p": ["p1"],
          until: 1629000000, // mismatch
        },
      ];

      for (const f of filters) {
        assert(!matchEventWithFilter(ev, f), `filter: ${JSON.stringify(f)}`);
      }
    }
  );

  await t.step("should ignore malformed tag query", () => {
    assert(matchEventWithFilter(ev, { "#multi-letter": ["foo", "bar"] }));
  });
});
