// Throwaway: put the stock question first in the queue (newest), the spend question last.
// Run after age.mts, the same way.
const W = new URL("../../../../apps/server/src", import.meta.url).pathname;
const { openPglite } = await import(`${W}/db/client.ts`);
const { db, close } = await openPglite(process.argv[2]);
await (db as any).$client.exec(`
  update decisions set created_at = now() - interval '8 minutes' where question like 'At what stock%';
  update decisions set created_at = now() - interval '2 days' where question like 'Spend up%';
`);
await close();
console.log("aged2");
