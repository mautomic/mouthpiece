# Gap-free player manual checklist

Run after `git pull` on the branch that has the player:

1. `mouthpiece build-helper && mouthpiece daemon restart`. In `~/.mouthpiece/daemon.log`, the `listening` line shows `"player":"stream"`.
2. With Kokoro first in the chain, ask Claude Code something with a long answer:
   - [ ] Speech starts about 1–1.5 s after the `summarized` line. It starts later when the summary opens with a very short sentence.
   - [ ] **Once it starts, it never pauses** until the end of the summary.
3. [ ] ⌃⌥S mid-sentence: silence at once. ⌃⌥N skips to the next item at once.
4. [ ] Dictate with Wispr Flow mid-response: speech pauses, then resumes at the sentence it was on.
5. [ ] Connect or disconnect AirPods mid-speech. Speech continues within about a sentence on the new output. The log may show `player_reset`. Note what you hear.
6. [ ] `pkill -f mouthpiece-player` mid-speech. Speech continues, maybe skipping the current sentence, and the log shows `player_exited`.
7. [ ] Leave Mouthpiece idle for a minute. `mouthpiece-player` uses no CPU in Activity Monitor, and `pmset -g assertions | grep -i audio` shows no audio assertion from it (the engine stops after 30 s idle, so the output device and the Mac can sleep).
8. [ ] Put `[provider] chain = ["say"]` in the config. `say` also speaks with no breaks between chunks.
9. [ ] Put `[player] backend = "afplay"` in the config, then `mouthpiece daemon restart`. The `listening` line shows `"player":"afplay"` and the old behavior returns. Remove the setting and restart.
10. [ ] Bluetooth headphones: note whether the first word is clipped, or the start is late.
