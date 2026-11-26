/**
 * Mirrors `@vibase/auth`'s `FULL_ACCESS_SCOPE` (a server-d1 test holds the two equal): `@vibase/api` does not depend on the provider package. [[CORE630]] D1, D5: the provider scope a person's default CLI login asks for. It is no Vibase scope:
 * never declared, in no role and on no agent record; discovery names it for the built-in provider and the authenticator reads it from the token's raw scope list. A leaf module, so discovery (answered before the composition loads) imports it
 * without the token verifier.
 */
export const FULL_ACCESS_SCOPE = 'all_permissions'
