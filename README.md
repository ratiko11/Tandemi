# Tandemi

**Tandemi finds the merge conflicts git can't see, and tells exactly who has to fix what.**

When two developers work on the same project, Tandemi merges their work **by the code's structure** (classes, methods, fields, statements), so separate changes never conflict even when git says they do. Then it builds and tests **each side alone and the merged code**, and sends every bug to the developer who wrote the line that broke. Their AI agent can fix it, and Tandemi tests again.

One engine, three ways to use it:

| | For | Where |
|---|---|---|
| **The Tandemi page** | any code: pasted, files, folders, a git project or a GitHub link | http://localhost:3000 |
| **MCP** | AI coders (Claude Desktop, Claude Code, Cursor) on Windows, Mac or Linux | `engine/mcp.js` |
| **GitHub merge bot** | every pull request, automatically, on GitHub | `action.yml` |

**ქართულად ქვემოთაა.**

## 0. The app (Windows)

Download **[Tandemi-Setup.exe](https://github.com/ratiko11/Tandemi/releases/latest/download/Tandemi-Setup.exe)** (or pick a version on the [Releases](https://github.com/ratiko11/Tandemi/releases) page) and run it once. It installs Tandemi like any other app: a desktop icon, a Start menu entry and an uninstaller. **No Node.js needed**, the app has its own. You still need **git**, and the tools of the languages you check (for example the **.NET SDK** for C#). From 2.4.3 on, the app **updates itself**: when a new version is on GitHub it asks once, and *Update now* installs it and opens Tandemi again (your accounts, teams and projects stay). **Help → Check for updates** looks right away. Windows may say *"Windows protected your PC"* because the app isn't signed yet: click **More info → Run anyway**.

The app keeps your things in **Documents\Tandemi** (final .zip files, projects opened from GitHub, the example) and its data (accounts, teams, settings) in **%APPDATA%\Tandemi\data**. **start.bat uses the same two places**, so your account and teams are the same in both. Run only one of them at a time. The first time the new start.bat runs, it copies what it had kept in this folder (`.pairplay`) to the shared place and leaves the old folder as a backup with a MOVED.txt note. The **Tandemi** menu has **Connect Claude Desktop (MCP)**, which replaces connect-claude.bat. To build the installer yourself, run **build-app.bat** (it needs Node.js once); the installer appears in `desktop\dist`.

## 1. Start (Windows)

1. Install **Node.js LTS** from https://nodejs.org and **git** from https://git-scm.com (once).
2. Double-click **start.bat** in this folder. Tandemi opens at **http://localhost:3000**.
3. Keep the black window open while you use Tandemi. Close it to stop.

On a Mac: double-click **start.command**.

To check C# code Tandemi needs the **.NET SDK** (https://dotnet.microsoft.com/download); for C++ a compiler (g++), for Python Python. JavaScript is checked by Tandemi itself.

## 2. The Tandemi page

One page, three steps: **Bring the code → What happened → Final code.**

At the top, choose who fixes the bugs: **Agents fix it** (each bug goes to its developer's AI agent, which fixes it; Tandemi checks again, up to 3 rounds, and keeps a fix only if the bug is gone; needs an Anthropic API key, see section 5) or **Just report**.

### 1 · Bring the code

- **Paste, files or folders.** Three columns: the **Original** (what both started from; optional, but it makes the merge much better), **Developer A** and **Developer B** (click a name to change it). For each, press **Paste code**, **Upload files**, **Upload folder**, drop files or a folder on the column, or type **a folder on this computer**. Tick **whole project** when a side is the complete project; leave it unticked when you only give the files that developer changed. `bin`, `obj`, `.git` and `node_modules` are skipped. Big projects are fine.
- **Git project or GitHub.** Type the project's folder (with `.git`) and press **Open**, or paste a GitHub link and press **Open from GitHub**. Pick Developer A's and Developer B's branch. **Get pushed branches** runs `git fetch`.
- **Example.** A small MonoGame-style C# game with two developers.

Press **Merge and test**.

### A whole team (3 or more developers)

Press **+ Add developer** (code tab) or **+ Add a branch** (git tab) to merge up to 12 developers at once. Tandemi works like a merge queue that explains itself:

- Every developer is merged **in order**, by structure. One who really conflicts with an earlier one (both changed the same part differently) **waits**; choose whose version to keep, keep both, or let AI combine them, and they join.
- Each developer is checked **alone**, then **everyone together**. When together breaks, Tandemi finds **exactly who clashes**: who wrote the broken line, whose change caused it (e.g. a rename), and if that isn't clear it checks the developers **in pairs**.
- Each bug goes to its owner (*"Gio, clashes with Ana"*). Meanwhile you get **"works now"**: everyone else, merged and checked. Fix the bugs (yourself or with the agents) and the waiting developers join automatically.
- **Final code**: download what works now or everyone merged, or save it as one git merge commit with every branch as a parent.

### Tests in plain words

Write what must stay true, in one sentence: *"The cat never jumps off the top of the screen."* Tandemi turns it into a real test in the project's own test framework, in a new file next to the existing tests. It can be written by Tandemi's AI (with an API key; if the first try doesn't build, Tandemi gives the AI the error and it tries again), by your AI coder through the MCP (`project_plain_tests`, then `project_plain_set_code`), or by you (**Write it myself**). Tandemi first checks that the test passes on the starting code. After that it runs with every check: on each developer's version and on the merge. When a merge breaks it, it is a bug like any other: *Your test "…" fails*, with what each developer changed and which change to undo. When a developer renames something the test uses, Tandemi updates its copy of the test for that version, so nobody is blamed for a test they didn't write. The tests are saved for the project and are part of the final code. (Two developers for now; the team merge gets them next.)

### Accounts and teams

Tandemi works like Discord or Slack. Open it and **create an account** (the first one owns this Tandemi), or **sign in**. Everyone has a **Personal space** (★ on the left) for working alone, and anyone can **create a team** with **+**. Invite people from **Settings → Team → Make an invite link**: they open the link, sign in or create an account, and they're in. The bar on the left shows your teams; click one to switch.

**Each team is its own world:** its own projects, merges, bugs, tests in plain words, API key and settings. Teams never see each other, and each runs in its own process, so one team's big build doesn't slow another. Roles: **owner** (everything, including deleting the team), **admin** (people, invites, the team's settings and API key, starting over), **member** (works: merges, fixes, tests).

**Settings** (top right): your **look** (theme, Arcade or Calm, the celebration) is yours alone. The team's settings (what happens when bugs are found, API key, model) are changed by its owner and admins. **AI coders (MCP)** → **Connect Claude Desktop** gives your Claude Desktop its own key for that team, so it works there as you. The owner of this Tandemi also decides whether anyone may create an account or only people with an invite, and whether laptops on the same Wi-Fi can open it.

**Safety:** passwords are stored only as salted scrypt hashes; 5 wrong passwords lock that address for 10 minutes; invite links can expire and be stopped; Tandemi refuses commands from other websites open in your browser; a folder on the computer running Tandemi can only be opened from that computer. Projects, tests and accounts from before teams move into the owner's Personal space by themselves.

### 2 · What happened

Tandemi merges every file by structure (C#, JavaScript, TypeScript, Python, Java, C++ and Go; other files line by line) and shows how many files plain git would stop on. Then it checks each side alone and the merged code: the project's build and tests when there is a project file (`.csproj`, `.sln`, `package.json`, pytest, `tandemi.json`), otherwise a compile check (C#, JavaScript, TypeScript, Python, Java, C++, Go). Python and JavaScript have no compiler, so Tandemi also reads the merged code: a name one developer removed or renamed that the other still uses becomes a bug right away, before any test runs. When code uses an outside library that isn't on this computer (a Java jar, a Go package, a C++ header), errors about that library are skipped and the rest is still checked. Every bug goes to the developer who wrote the line, with a hint like *"Ana renamed RunSpeed to Speed in Cat.cs. Use Speed here."* Something that works on both sides but breaks after the merge means the two changes clash. Real conflicts (both changed the same thing differently) are shown with **Use A's**, **Use B's**, **Keep both** or **Let AI combine**. **Details** lists every changed file and each test.

### 3 · Final code

**Download final code (.zip)**. For a git project also **Save as merge branch**: a real git merge commit (both branches as parents) to push and open a pull request. You can open any file of the merged code, see who wrote each line, change it and save: Tandemi checks it again.

Committed `bin/` and `obj/` folders are skipped (they're rebuilt). Windows line endings are kept.

### How Tandemi builds and tests a git project

It detects it: `dotnet test` (with TRX results) for C# test projects, `dotnet build` otherwise, `npm test`, `pytest`, Maven (`mvn test`), Gradle (`gradle test`) and `go test`. To choose yourself, put a `tandemi.json` in the project:

```json
{
  "name": "My Game",
  "kind": "game",
  "build": "dotnet build MyGame.sln",
  "test": "dotnet test MyGame.sln --logger trx --results-directory {results}",
  "results": "{results}/*.trx",
  "timeoutSec": 900
}
```

`{results}` is a folder Tandemi gives each run. Results can be TRX (dotnet test), NUnit XML or JUnit XML (pytest, Jest and most others). For MonoGame, keep the game logic in a class library (like the sample's `CatGame.Core`) so tests run without opening a window. A project without tests is still checked: each side and the merge must **build**.

## 3. AI coders (MCP)

**Claude Desktop:** double-click **connect-claude.bat** (Mac: connect-claude.command), press Enter, then fully quit and reopen Claude Desktop.
**Claude Code:** `claude mcp add tandemi -- node "C:\tandemi\engine\mcp.js"`

The MCP works **on its own**; when Tandemi is open, the page shows what the AI coder does, live.

Ask Claude for example:
- "Use Tandemi: merge Ana's version in C:\work\ana and Beka's in C:\work\beka (original in C:\work\original), fix the bugs and give me the final code."
- "Use Tandemi: open C:\Projects\MyGame, merge dev-ana and dev-beka, and fix the bugs sent to Beka."
- "Use Tandemi to merge these three versions of Player.cs."

Tools: `ws_new`, `ws_add_files`, `ws_folder`, `ws_remove`, `ws_clear`, `ws_status`, `ws_add_developer`, `ws_remove_developer`, `ws_merge` (any code), `team_merge`, `team_status`, `team_resolve`, `team_read_file`, `team_write_file`, `team_retest`, `team_fix_bug`, `team_final`, `team_save_branch` (3 or more developers), `project_open`, `project_clone` (GitHub link), `project_sample`, `project_status`, `project_fetch`, `project_merge`, `project_pick`, `project_read_file`, `project_write_file`, `project_retest`, `project_fix_bug`, `project_mode`, `project_final`, `project_save_branch`, and quick merges without checks: `merge_files`, `merge_folders`, `merge_pick`, `merge_status`.

## 4. GitHub merge bot

On every pull request, GitHub runs Tandemi on its own computers: it merges the pull request with its base branch by structure, builds and tests both sides and the merge, and posts **one comment** that tags who has to fix what (it updates on every push). The check turns red while bugs remain and green when the merge is safe. When git can't merge but Tandemi can, it pushes its merged code to `tandemi/pr-<number>`.

1. Put Tandemi on GitHub once: create a repository (for example `ratiko11/tandemi`) and push this folder to it.
2. In your project, add the file `github/tandemi.yml` from this folder as `.github/workflows/tandemi.yml`. Change `ratiko11/tandemi` if your repository has another name, and the .NET version if needed. Use `runs-on: windows-latest` for WinForms/WPF.
3. Optional: add an `ANTHROPIC_API_KEY` secret in the project's GitHub settings, so the bot's agents can combine real conflicts (and fix bugs with `fix: 'true'`).

Try it on your computer first: `node engine/bot.js --repo C:\Projects\MyGame --base dev-a --head dev-b` prints the same report.

## 5. Claude inside Tandemi (the agents)

Tandemi's own agents fix bugs and combine conflicts with Claude, in one of two ways (Settings, **Who does the AI work**):

- **Claude Code**, with your Claude plan (Pro or Max): no API key and no credits. Install it once with `npm install -g @anthropic-ai/claude-code`, type `claude`, and sign in with **Claude account with subscription**.
- **An Anthropic API key** (at the top of the page), paid per use with credits from console.anthropic.com. It's saved only on this computer, in Tandemi's data folder; never share it.

**Automatic** uses the key when there is one and Claude Code otherwise. If the key has no credits left, Tandemi switches to Claude Code by itself. AI coders through the MCP need neither.

## If something goes wrong

- **"Port 3000 is busy"**: Tandemi is already running in another window. Close it.
- **Nothing is checked / "dotnet isn't installed"** for C#: install the .NET SDK and start Tandemi again.
- **"Git is not installed"**: install it from https://git-scm.com and start Tandemi again.
- **"dotnet isn't installed"** or **"does not support targeting .NET 10"**: install the .NET SDK your project uses (https://dotnet.microsoft.com/download).
- **The first build of a project is slow**: .NET downloads the project's packages once; it needs internet.
- **"tandemi" doesn't appear in Claude Desktop**: quit it fully and reopen. Run connect-claude.bat again if you moved the folder.

---

## License

© 2026 Rati Shetsiruli. Tandemi is free for personal use, study, students, schools and open-source projects, under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Using it in a company or in anything sold needs a separate license: ask on [GitHub](https://github.com/ratiko11/Tandemi/issues). The licenses of the parts Tandemi includes (tree-sitter, acorn, the fonts) are in `engine/vendor`.

## ქართულად

**Tandemi** პოულობს merge-ის კონფლიქტებს, რომლებსაც git ვერ ხედავს, და ზუსტად ამბობს, ვინ რა უნდა გაასწოროს. ორი ან მეტი დეველოპერის კოდს კოდის სტრუქტურით აერთიანებს (კლასები, მეთოდები, ველები; C#, JavaScript, TypeScript, Python, Java, C++, Go), ამიტომ ცალკეული ცვლილებები ერთმანეთს არ ეჯახება. მერე ააწყობს და დატესტავს ცალ-ცალკე თითოეულ მხარეს და გაერთიანებულ კოდს, და ყოველ ბაგს იმას უგზავნის, ვინც გატეხილი ხაზი დაწერა.

**ერთი ძრავა, სამი გზა:** Tandemi-ს გვერდი (ნებისმიერი კოდი: ჩასმული, ფაილები, საქაღალდეები, git პროექტი ან GitHub ლინკი), MCP (AI coder-ებისთვის) და GitHub merge bot (ყოველ pull request-ზე ავტომატურად).

**გაშვება:** დააინსტალირე **Node.js LTS** (https://nodejs.org) და **git** (https://git-scm.com), მერე ორჯერ დააწკაპე **start.bat**. გაიხსნება http://localhost:3000. C# კოდის შესამოწმებლად საჭიროა **.NET SDK**.

**მთელი გუნდი:** **+ Add developer** ან **+ Add a branch** ღილაკით ერთდროულად 12-მდე დეველოპერის გაერთიანებაა შესაძლებელი. Tandemi პოულობს, ზუსტად ვინ ეჯახება ვის, ბაგს მის მფლობელს უგზავნის, და მანამდე გაძლევს „works now“ ვერსიას: ყველას, ვინც ერთად მუშაობს.

**გვერდი, სამი ნაბიჯი:** 1) **კოდის მოტანა**: ორიგინალი (არასავალდებულო), Developer A და Developer B: ჩასვი კოდი, ატვირთე ფაილები ან საქაღალდე, ან გახსენი git პროექტი / GitHub ლინკი და აირჩიე ორი ბრანჩი. მერე **Merge and test**. 2) **რა მოხდა**: რამდენ ფაილზე გაჩერდებოდა git, რეალური კონფლიქტები, ბაგები და ვის გაეგზავნა თითოეული. 3) **საბოლოო კოდი**: ჩამოტვირთე .zip-ად (ან git-ში merge ბრანჩად შეინახე). ზემოთ აირჩიე: **Agents fix it** (აგენტები თვითონ ასწორებენ ბაგებს) ან **Just report**.

**ტესტები ჩვეულებრივი სიტყვებით:** ერთი წინადადებით დაწერე, რა უნდა დარჩეს სწორი (მაგ. „კატა ეკრანის ზემოთ არასდროს გადახტება“). Tandemi მას პროექტის საკუთარ ფრეიმვორკში ნამდვილ ტესტად აქცევს: დაწერს AI (API key-ით), შენი AI coder MCP-ით, ან შენ თვითონ. ჯერ ამოწმებს, რომ საწყის კოდზე გადის, მერე ყოველ შემოწმებაზე უშვებს: თითოეული დეველოპერის ვერსიაზე და გაერთიანებულ კოდზე. თუ merge მას გატეხავს, ჩვეულებრივ ბაგად ჩანს.

**აპლიკაცია:** ერთხელ გაუშვი **Tandemi Setup.exe**: ჩაიდგმება როგორც ჩვეულებრივი პროგრამა (ხატულა სამუშაო მაგიდაზე და Start მენიუში). Node.js აღარ არის საჭირო. თუ Windows იტყვის „Windows protected your PC“, დააჭირე **More info → Run anyway**.

**ანგარიშები და გუნდები:** Tandemi მუშაობს როგორც Discord: შექმენი ანგარიში ან შედი. ყველას აქვს **Personal space** (★), და ნებისმიერს შეუძლია **+** ღილაკით შექმნას **გუნდი** და მოიწვიოს ხალხი ლინკით (Settings → Team). თითოეულ გუნდს აქვს საკუთარი პროექტები, ბაგები, ტესტები და API key, და გუნდები ერთმანეთს ვერ ხედავენ. როლები: owner, admin, member.

**MCP:** ორჯერ დააწკაპე **connect-claude.bat**, მერე Claude Desktop თავიდან გახსენი. MCP დამოუკიდებლადაც მუშაობს.

**GitHub merge bot:** Tandemi-ს საქაღალდე ატვირთე GitHub-ზე (მაგ. `ratiko11/tandemi`), შენს პროექტში კი `github/tandemi.yml` ჩადე როგორც `.github/workflows/tandemi.yml`. ყოველ pull request-ზე GitHub თვითონ გაუშვებს Tandemi-ს და დაწერს კომენტარს, ვინ რა უნდა გაასწოროს.
