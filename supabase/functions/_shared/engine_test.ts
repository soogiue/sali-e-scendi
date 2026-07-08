// Primo test del repo: deno test supabase/functions/_shared/engine_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { roundsSequence, maxCardsFor } from "./engine.ts";

Deno.test("roundsSequence storica: 1..max, max..1 (picco doppio)", () => {
  const seq = roundsSequence(10);
  assertEquals(seq.length, 20);
  assertEquals(seq[0], 1);
  assertEquals(seq[9], 10);
  assertEquals(seq[10], 10);
  assertEquals(seq[19], 1);
});

Deno.test("roundsSequence con partenza: 4 -> 10 -> 4", () => {
  const seq = roundsSequence(10, 4);
  assertEquals(seq, [4,5,6,7,8,9,10,10,9,8,7,6,5,4]);
  assertEquals(seq.length, 2 * (10 - 4 + 1));
});

Deno.test("roundsSequence partenza == picco: [picco, picco]", () => {
  assertEquals(roundsSequence(8, 8), [8, 8]);
});

Deno.test("roundsSequence clampa input fuori range", () => {
  assertEquals(roundsSequence(8, 99), [8, 8]);        // sopra il picco
  assertEquals(roundsSequence(8, 0), roundsSequence(8)); // sotto 1
});

Deno.test("maxCardsFor: 4 -> 10, 5 -> 8 (invariata)", () => {
  assertEquals(maxCardsFor(4), 10);
  assertEquals(maxCardsFor(5), 8);
});
