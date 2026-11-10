// Throwaway: spread the made-up rows' times so the screenshots look lived in, and put the contact-form question first.
// Run from apps/server with the server stopped: node_modules/.bin/tsx <this file> <the seeded PGlite folder>
const W = new URL("../../../../apps/server/src", import.meta.url).pathname;
const { openPglite } = await import(`${W}/db/client.ts`);
const { db, close } = await openPglite(process.argv[2]);
await (db as any).$client.exec(`
  update tickets set last_activity_at = now() - (interval '1 minute' * (5 + (number * 97) % 2900));
  update decisions set created_at = now() - interval '8 minutes' where question like 'How many contact%';
  update decisions set created_at = now() - interval '3 hours' where question like 'Moving the site%';
  update decisions set created_at = now() - interval '40 minutes' where question like 'Approve the new%';
  update decisions set created_at = now() - interval '2 days' where question like 'Dark mode has%';
  update feedback_notes set created_at = now() - (interval '1 hour' * (abs(hashtext(text)) % 300));
`);
await close();
console.log("aged");
