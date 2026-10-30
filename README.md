# Floor prototype

A small browser voice call for testing one idea: **when two people jump into the same pause,
the first one gets the floor and the second one is held back for a few seconds**, with a red
bar telling them so. Pressing **Space** (or "Talk anyway") opens their mic straight away.

It's a test rig for finding out whether this *feels* good in real conversation before building
anything that plugs into Zoom or Teams.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd floor-prototype
npm install
npm start
```

Open <http://localhost:3000>, enter a name and a room, and join. To try it alone, open a second
browser window (or click **Test: bot grabs floor**, then start talking straight away).

**Use headphones.** With speakers, other people's voices leak into your mic and count as you talking.

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
4. **Being held** turns your outgoing audio to zero (or 20% in "duck" mode). The mic keeps
   listening locally, so nothing is lost on your side. You see the red bar and, optionally, hear a short tone.

All of the numbers above can be changed live in the **Room settings** panel.

## Things to watch for while testing

- Does the held person notice the red bar, or do they keep talking? Is the tone better?
- Is 3 seconds too long or too short? Does "duck" feel better than "mute"?
- How often does it fire on false alarms (laughs, "mm-hm", keyboard)? Try the threshold slider.
- How often do people reach for Space? If it's a lot, the collision window is probably too wide.
- The **What happened** log shows the measured gap for every collision, which is useful for
  seeing how close real collisions actually are.
