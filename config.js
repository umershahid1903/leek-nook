// Shared by the site (browser) and the night watch (GitHub Actions, Node 24).
export default {
  coin: 'CyberLeek',
  chain: 'solana',
  mint: 'ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg',
  defaultTarget: 30_000_000,
  rearmBelow: 0.9, // after ringing, the bell re-arms once the cap falls under 90% of the target

  repo: 'umershahid1903/leek-nook',
  workflow: 'bell.yml',

  // Public halves only — the private keys live in the repo's Actions secrets.
  vapidPublicKey: 'BD-vwevh5qq29ccGinYrbGCux4aSM5Fde-c4ap0GbL-gt8hi_Y2nXH0rBGE4q-2F6cEegYV5pRWHtJwog-pLrko',
  mailboxPublicKey: 'BFzuKP1F-0bKzRruAZ_y5uRYjdOFBtmNIYfDAr5Qox2iJeyk9MDxkVpz2eRynUe_5uofkMnoejvFA8p-oHzdRXw',
  mailboxTopic: 'leeknook-rg4xfakqx0bwm8yrvqwg',
};
