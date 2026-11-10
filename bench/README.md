# Real-merge benchmark

Replays real merges from public projects where git's own merge stopped with conflicts, runs Tandemi's merge on the
same files, and compares with what the developers actually committed. Run it after every change to `engine/merge.js`.

```
git clone --bare https://github.com/jellyfin/jellyfin.git repos/jellyfin.git      # any public repos
node extract.js repos/jellyfin.git cases/jellyfin.jsonl 6000                         # conflicting merges → cases
node score.js ../engine scored.json cases/*.jsonl                                    # same / different / conflict
node lostlines.js ../engine scored.json                                              # lines lost that nobody deleted (must be ~0)
node parsecheck.js ../engine scored.json                                             # does every merged file still parse
```

Results on 1,271 code files from 8 projects (MonoGame, Jellyfin, Vue, Flask, Requests, Axios, Gin, Gson), October 2026:

| | before | after |
|---|---|---|
| merged with no human help | 380 (30%) | 492 (39%) |
| exactly what the developers committed | 174 | 250 |
| files that lost lines nobody deleted | 112 | 7 |
| merged files that no longer parse | 0 | 0 |
