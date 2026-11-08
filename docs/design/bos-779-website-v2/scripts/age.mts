// Throwaway: spread the made-up rows' times so the screenshots look lived in.
// Run from apps/server with the server stopped: node_modules/.bin/tsx <this file> <the seeded PGlite folder>
const W = new URL("../../../../apps/server/src", import.meta.url).pathname;
const { openPglite } = await import(`${W}/db/client.ts`);
const { db, close } = await openPglite(process.argv[2]);
const c = (db as any).$client;
await c.exec(`
  update tickets set last_activity_at = now() - (interval '1 minute' * (5 + (number * 97) % 2900));
  update decisions set created_at = now() - interval '26 hours' where question like 'At what stock%';
  update decisions set created_at = now() - interval '3 hours' where question like 'The card payment%';
  update decisions set created_at = now() - interval '40 minutes' where question like 'Approve the new%';
  update decisions set created_at = now() - interval '12 minutes' where question like 'Spend up%';
`);
await close();
console.log("aged");
