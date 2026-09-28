# TODOS

## Discuss Approach C: Hive Mind (Kumar asked to be reminded)

- **What:** Every visitor's browser becomes an evolution island. The swarm already
  evolving in each tab would periodically send its best genome to the server, and the
  server would send migrants back.
- **Why:** "The more people watch, the faster it learns." It's the strongest "whoa" story
  in the original brainstorm, and it builds on the verification server with no rework.
- **Pros:** viewers become the training cluster; a genuinely novel showcase.
- **Cons:** with 0 visitors it looks empty (the server island is still needed); every
  migrant genome must be server-verified (untrusted compute); convergence behaviour with
  many islands needs tuning.
- **Context:** design doc (Approach C) at `docs/designs/dino-forever.md`. The server
  already re-plays untrusted runs (`server/verify.ts`); an island upload would be a
  genome plus claimed fitness, verified the same way as `/api/trainer/candidate`.
- **Depends on:** the live server being deployed (M3).

## Nice to have

- Record a GIF of `node scripts/real-chrome.mjs` playing the literal chrome://dino for the
  README.
- Measure throughput on the real Fly machine and set the attack-verification latency
  target from it (design doc: Reviewer Concerns #1).
