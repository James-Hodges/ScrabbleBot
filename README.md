# ScrabbleBot

Our entry for [ScrabbleBot](https://scrabblebot.spacetimedb.com/docs), a letter-auction word game for bots.

- [STRATEGY.md](STRATEGY.md): rules (checked against the server code) and game theory.
- [ANALYSIS.md](ANALYSIS.md): what the public match history says about the current meta.
- [PLAN.md](PLAN.md): sprints and backlog.

## Running the bot

The bot is in [`bot/`](bot/), built on the official TypeScript starter kit (MIT, see `bot/LICENSE-starter`).

### One-time setup

You need Node.js. You only need the [spacetime CLI](https://spacetimedb.com/install) to regenerate the bindings.

```bash
cd bot
npm install
```

The generated bindings (`src/module_bindings/`) and the server's wordlist (`data/wordlist.txt`) are committed, so the bot runs without the CLI. Regenerate both if the game server changes:

```bash
npm run generate
```

### Getting the token in (first run only)

1. On the [team page](https://scrabblebot.spacetimedb.com/team), click **Generate token** and copy it.
2. From the `bot/` folder, save it to a token file without it showing on screen or in your shell history.

   On macOS, straight from the clipboard:

   ```bash
   pbpaste > .token-main
   ```

   On any system, type it in hidden:

   ```bash
   read -rs TOKEN && printf '%s' "$TOKEN" > .token-main && unset TOKEN
   ```

3. Start the bot:

   ```bash
   BOT_NAME=main npm start
   ```

`BOT_NAME` only picks which `.token-<name>` file to use; the bot's real name comes from the server. Every later run is just `BOT_NAME=main npm start`.

**Never commit or share the token.** `.token-*` is git-ignored. If a token leaks, generate a new one on the team page.

### What a healthy start looks like

```
[main] connected as …
[main] subscription applied
[main] acting as bot '<our bot name>' (id …)
```

Then it joins the lobby and starts bidding once a match begins (the lobby waits up to 90 seconds). If you see `no BotCredential for this token`, the token file is wrong or empty: generate a new token and save it again.

### Tests

```bash
npm test
```

### Tournament

```bash
BOT_NAME=main TOURNAMENT_ID=<id> npm start
```

Keep the bot running for the whole tournament. Offline bots still get seated and lose every auction they don't bid in.
