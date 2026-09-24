# Lumenwake

A short-session 1–4 player cooperative game for AXM Game Night.

Collect cyan, violet and gold fallen light, carry up to three pieces, and return them to the central aurora. Gloom hunts carriers and drains the core. Pulse to stun it, dash to escape, and stand close to relight fallen teammates.

- One to four visible Human or AI seats
- Solo difficulty scales from the same rules
- Same server-authoritative move, pulse and dash vocabulary for humans and AI
- Keyboard desktop play, touch phone controller and shared spectator screen
- Three-minute sessions and seven local in-game achievements
- No hidden players, automatic seat replacement, internet dependency or purchases

## Controls

- Desktop: WASD or arrows, Space to Pulse, Shift to Dash
- Phone: move stick, Pulse and Dash
- AI seats: imperfect local decision loop using the same movement and action fields

The phone controller shows authoritative Pulse and Dash cooldowns and confirms
accepted actions. On the shared screen, each Gloom draws its current server-
selected target so the party can see who needs cover without changing the
underlying targeting rules.

## Achievement boundary

Game achievements are stored locally under `axm.lumenwake.achievements.v1`. The shared AXM profile still receives its normal verified `game-played` receipt from Game Hub; Lumenwake does not invent shared-profile event types.
