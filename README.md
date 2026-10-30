# 🚀 Launch Window

**Every pause is a launch window, and only one person gets through it.**

When two people jump into the same gap in a conversation, Launch Window lets the first one
through and puts the second on hold for a few seconds. They get a red bar saying who launched
first and a T-minus countdown until their mic reopens. If they really do need to cut in, they
press **Space** to launch anyway.

It runs in the browser: no installs for participants, just a link.

## Why this exists

The recent Moonshots episode where the whole team was together in the studio was a much calmer,
easier listen. In the same room, people read each other's cues, so the overtalk sorted itself
out. Remotely, those cues arrive a fraction of a second late, and two people jump into the
same pause far more often.

The Moonshots team is busy and usually in different locations when recording, so getting
everyone into a studio isn't always realistic. Launch Window is an attempt to see whether that
studio calm can be recreated remotely, by managing who gets each gap in the conversation.

It doesn't need to be perfect. Cutting overtalk by 90% or more would already make a real
difference to how the show sounds.

## For the Moonshot podcast: quick start

1. **Before the episode:** one person runs it (see *Run it* and *Trying it with colleagues*
   below) and sends round the invite link.
2. **Everyone joins** with the link, types their name, and allows the microphone.
3. **Do a 30-second warm-up.** Each person talks and checks their mic bar turns **green**. If it
   flickers green on background noise, nudge the *Speech threshold* slider right. Then click
   **Test: bot launches** and start talking straight away, so everyone knows what the red bar
   looks like before it happens for real.
4. **Headphones are best.** Speakers are OK too: the echo guard learns to ignore them (the mic
   bar shows purple when it does). Two hosts sitting in the same room on separate laptops is the
   one setup it can't handle, so share a laptop or use headphones.
5. **Recording.** Launch Window is the conversation, not the recorder. Keep recording the way
   you do now: each host recording their own mic locally (a "double-ender") works especially
   well. Your local recording still has everything you said while on hold, so the editor
   decides what stays.

Worth tweaking after the first episode, in **Room settings** (changes apply to everyone):
- *Put the second speaker on hold for*: 3 s by default. Fast back-and-forth may prefer 1.5–2 s.
- *Count as a collision if they start within*: 1.2 s by default. Lower it if people get put on
  hold when they meant to cut in.
- *Just for you → Turn my mic down to 20% while on hold*: gentler than a hard mute.

The **What happened** panel lists every collision and how close it was, which makes a fun stat
for the show.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>, enter a name and a room, and join. To try it alone, open a second
browser window (or click **Test: bot launches**, then start talking straight away).

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
     then gives the floor to the earliest start. Everyone else is put on hold.
   - If someone launched less than 1.2 s ago, a new speaker is treated as a collision and put on hold.
   - If someone has been talking longer than that, a new speaker is an ordinary interruption
     and is left alone.
   - If the winner stops within 400 ms (a cough, an "um"), everyone on hold is released.
   - Fairness: whoever lost the last collision wins the next one.
4. **Echo guard** (see below) stops other people's voices coming out of your speakers from
   counting as you talking.
5. **Being put on hold** turns your outgoing audio to zero (or 20% in "duck" mode). The mic keeps
   listening locally, so nothing is lost on your side. You see the red bar and, optionally, hear a short tone.

All of the numbers above can be changed live in the **Room settings** panel.

## Echo guard: using speakers instead of headphones

With speakers, other people's voices come back into your mic. Without protection, every time
someone else talked, your echo would look like you jumping in, and you'd be put on hold for
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

## Test the idea yourself

### 1. Get it running (no install needed)

On the GitHub repo page: **Code → Codespaces → Create codespace on main**. It installs
everything, starts the server, and opens Launch Window in a new tab, already on `https://`, so
the mic works. To let others join: open the **Ports** tab, right-click port 3000 →
**Port visibility → Public**, and share that address. (Codespaces is free for a generous
number of hours a month; stop the codespace when you're done.)

Or run it on your own machine (see *Run it* and *Trying it with colleagues* above).

### 2. Feel it on your own (5 minutes)

Join, check your mic bar goes green when you talk, then click **Test: bot launches** and start
talking straight away. That's exactly what being put on hold feels like. Try Space, and try
"Turn my mic down to 20%" instead of mute.

### 3. Measure it with 2–4 people (about 30 minutes)

Ideally everyone is in a different place, as on a remote recording. Pick a format that creates
lots of pauses to jump into, such as an open discussion where anyone can answer, or each person
bringing three questions to throw to the group.

| Round | Setting | At the start | Write down at the end |
|---|---|---|---|
| **A: baseline**, 10 min | Tick **Measure only** → Apply | **Reset counts** | *overtalks* |
| **B: Launch Window**, 10 min | Untick **Measure only** → Apply | **Reset counts** | *collisions*, *launched anyway* |

In round A everyone hears every overtalk. In round B, the only overtalk anyone actually hears is
when someone pressed Space ("launched anyway"). So:

> **Overtalk reduction ≈ 1 − (launched anyway in B ÷ overtalks in A)**, for rounds of equal length.

90% or more is the goal. Next time, run the rounds the other way round, because people
naturally get more polite as a conversation goes on.

Then ask everyone, 1–5: *How natural did round B feel? Did the red bar annoy you? Did you feel
cut off unfairly?* A big reduction that everyone hates isn't a win.

The counts only include collisions the tool detected. If you can, record the call (for
example each person records their own mic, or one person screen-records with audio) and
listen back to catch any it missed.

## Things to watch for while testing

- Does the person on hold notice the red bar, or do they keep talking? Is the tone better?
- Is 3 seconds too long or too short? Does "duck" feel better than "mute"?
- How often does it fire on false alarms (laughs, "mm-hm", keyboard)? Try the threshold slider.
- How often do people reach for Space? If it's a lot, the collision window is probably too wide.
- The **What happened** log shows the measured gap for every collision, which is useful for
  seeing how close real collisions actually are.
