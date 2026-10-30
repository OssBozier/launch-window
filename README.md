# Floor prototype

A small browser voice call for testing one idea: **when two people jump into the same pause,
the first one gets the floor and the second one is held back for a few seconds**, with a red
bar telling them so. Pressing **Space** (or "Talk anyway") opens their mic straight away.

It's a test rig for finding out whether this *feels* good in real conversation before building
anything that plugs into Zoom or Teams.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>, enter a name and a room, and join. To try it alone, open a second
browser window (or click **Test: bot grabs floor**, then start talking straight away).

Headphones work best, but speakers are fine. See **Echo guard** below.

## Tests

```bash
npm test
```

This runs the server's floor decisions against fake clients, and the speech/echo detector
against simulated rooms (`test/`).

## Trying it with colleagues

Browsers only allow the microphone on `https://` pages (or `localhost`), so the server needs
an https address. The quickest option is a tunnel from your machine:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

It prints an `https://….trycloudflare.com` address. Join, click **Copy invite link**, and send
it round. (`npx localtunnel --port 3000` works too.) For something longer-lived, deploy the
folder to any Node host (Render, Railway, Fly.io…); it only needs `npm start` and the `PORT`
environment variable.

Audio goes directly between browsers (a "mesh"), which is fine for about 2–6 people. On some
strict office or mobile networks browsers can't reach each other directly. The tile then
stays on "connecting"/"failed", and you'd need to add a TURN server to `ICE` in `public/app.js`.

## How it works

1. **Each browser detects its own speech** (`public/vad-worklet.js`, on the audio thread). A
   start only counts if at least 60% of the next 100 ms is also loud enough, which filters out
   clicks and taps. The reported start time is the *first* loud moment, not the moment it was
   confirmed.
2. **Clocks are synced** with the server (ping/pong, keeping the fastest round trip), so start
   times from different computers can be compared fairly, not just by whose message arrived first.
3. **The server decides** (`server.js`):
   - If nobody has the floor, it waits 80 ms to collect anyone else starting at the same moment,
     then gives the floor to the earliest start. Everyone else is held.
   - If someone took the floor less than 1.2 s ago, a new speaker is treated as a collision and held.
   - If someone has been talking longer than that, a new speaker is an ordinary interruption
     and is left alone.
   - If the winner stops within 400 ms (a cough, an "um"), everyone held is released.
   - Fairness: whoever lost the last collision wins the next one.
4. **Echo guard** (see below) stops other people's voices coming out of your speakers from
   counting as you talking.
5. **Being held** turns your outgoing audio to zero (or 20% in "duck" mode). The mic keeps
   listening locally, so nothing is lost on your side. You see the red bar and, optionally, hear a short tone.

All of the numbers above can be changed live in the **Room settings** panel.

## Echo guard: using speakers instead of headphones

With speakers, other people's voices come back into your mic. Without protection, every time
someone else talked, your echo would look like you jumping in, and you'd get a red bar for
saying nothing. There are three layers of defence:

1. **The browser's echo canceller** (on by default) removes most of it, typically 20–40 dB.
   For that to work, other people's audio has to play through a normal `<audio>` element,
   which it does.
2. **Shape check.** The detector gets a copy of everything the page plays. Echo rises and falls
   syllable by syllable in step with that playback, 20–300 ms later. Your own voice doesn't.
   If the mic's loudness changes match the playback's at some delay, it's treated as echo.
3. **Level check.** From sound that passes the shape check, it learns how loudly your speakers
   leak into your mic, and it re-learns if you change the volume. While someone else is
   audible, the mic only counts as you if it's at least 6 dB louder than that expected echo.

None of this applies in a silent gap, which is exactly where collisions happen. So the echo
guard costs nothing in the case the app cares about. On the mic meter, purple means "ignored
as echo", and the purple line is the current expected echo level. The guard can be turned off
under **Just for you**.

`public/vad-worklet.js` has been tested against simulated rooms: quiet speakers, loud laptop
speakers with no echo cancelling, echo louder than the original, starting at the same instant
as someone else's audio, and talking over someone. Known limits:

- If the echo of someone else is *louder than your own voice* at your mic, you won't be
  detected until they stop. Turn the speakers down or move the mic closer.
- Starting to talk loudly *while someone else is talking* takes about half a second to register.
  That doesn't matter much, since interruptions aren't held anyway.
- **Two people in the same physical room on separate laptops** isn't covered. Your neighbour's
  voice reaches your mic directly, before it arrives over the network, so there's no playback
  to match it against. Raise the speech threshold, or have them share one laptop.

A speakerphone with built-in echo cancelling (e.g. a USB conference puck) is the most robust
no-headphones setup.

## Things to watch for while testing

- Does the held person notice the red bar, or do they keep talking? Is the tone better?
- Is 3 seconds too long or too short? Does "duck" feel better than "mute"?
- How often does it fire on false alarms (laughs, "mm-hm", keyboard)? Try the threshold slider.
- How often do people reach for Space? If it's a lot, the collision window is probably too wide.
- The **What happened** log shows the measured gap for every collision, which is useful for
  seeing how close real collisions actually are.
