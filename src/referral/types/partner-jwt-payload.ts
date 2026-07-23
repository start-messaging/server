/** Claims carried by a referral-partner access token. */
export interface PartnerJwtPayload {
  sub: string;
  email: string;
  /** Marks the token as a partner token — customer routes use a different
   *  secret, so this is defence-in-depth against cross-audience reuse. */
  typ: 'partner';
}
