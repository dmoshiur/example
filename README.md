# DayDing — Daily Routine Alarms ⏰

A mobile-first website that keeps your daily routine on schedule: a proper
routine table with per-routine alarms, built-in ringtones, and snooze support.

## Features

- 📋 **Routine table** — time, activity, notes, repeat days, ringtone, and an
  on/off alarm switch for every entry (starts with a sensible default day).
- 🔔 **Ringtones** — four built-in ringtones synthesized with the Web Audio
  API (no audio files needed): Classic Bell, Digital Beep, Gentle Chime,
  Morning Rise. Preview any of them with the ▶ button.
- 😴 **Snooze** — full-screen ringing alarm with *Snooze 5 min* and *Dismiss*.
  Snoozes survive page reloads.
- 📱 **Mobile-first responsive** — the table renders as touch-friendly cards
  on phones and as a classic table on tablets/desktop. Large tap targets,
  bottom-sheet form, vibration on supported phones, optional notifications.
- 💾 **Local storage** — routines live in `localStorage`; no account, no server.

## Run it locally

It's a static site — any web server works:

```bash
python3 -m http.server 8080 --bind 0.0.0.0
# then open http://localhost:8080
```

> Note: browsers only allow audio after a user gesture, so tap
> **“Enable sound”** once when you open the page. Keep the tab open for
> alarms to ring.

## Files

```
index.html      — page structure (table, alarm overlay, add/edit modal)
css/styles.css  — mobile-first styles
js/app.js       — scheduler, ringtones, snooze, persistence
```
