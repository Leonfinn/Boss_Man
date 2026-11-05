// What the owner types into the app's message boxes (a run's message, a ticket's conversation, the
// CEO chat, a decision's answer), and how far it travels: the browser's textarea, the server's
// validation and the connection to the runner must all allow the same amount, so a pasted log is
// never cut off on the way. Shared so the four agree exactly.
//
// A real log can be large, so the cap is generous; past it the box says so before sending and
// offers to send the text as a .txt attachment instead (attachments go through the file upload,
// which has its own limit).

/** The most characters an owner's message can be: the same in every box and on the server. */
export const OWNER_MESSAGE_MAX = 200_000;

/** From this many characters the box shows a character count, so the owner can see it all went in. */
export const OWNER_MESSAGE_COUNT_FROM = 5_000;
