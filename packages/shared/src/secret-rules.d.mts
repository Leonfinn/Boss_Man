export const PLACEHOLDER: RegExp;
export const entropy: (s: string) => number;
export const SECRET_RULES: Array<[string, RegExp, ((value: string) => boolean)?]>;
export function findSecretKind(text: string): string | null;
