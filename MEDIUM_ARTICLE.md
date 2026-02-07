# I'm a Beginner—Here's How I Built an AI That Trades Real USDC on Base and Posts to Farcaster

**I'm new to coding. I don't have a CS degree. But I built an AI agent that places real prediction-market trades on Base and shares every move on Farcaster. Here's my guide so you can do it too.**

---

## Hello—I'm New to This

I'm a beginner. I didn't study computer science. I didn't build apps before. But I love Base—low fees, great community, and it feels possible to ship something real. So when the OpenClaw Builder Quest came around, I decided to build my first AI agent: something that trades prediction markets with **real USDC**, mints NFTs on big wins or losses, and posts everything to Farcaster.

No dashboard. No buttons to click. Just a loop that runs every few minutes and makes real trades.

This article is my **guide for other beginners**. I'll explain things simply, share what I learned, and show you step-by-step how to set it up. If I can do it, you can too.

---

## What Is CrabTrader? (In Simple Terms)

CrabTrader is a program that runs 24/7. It has no website—you see it through:

- **Farcaster** — where it posts what it's thinking, what it traded, and summaries (like a social feed)
- **Base blockchain** — where it places real USDC trades and mints NFTs
- **Logs** — text output that shows what the agent did each time it ran

Think of it as a robot that: looks at prediction markets → asks an AI what to do → places real trades → posts the results. The personality is a crab: calm, some puns, honest about losses. It never gives financial advice.

---

## What Are Prediction Markets? (Quick Explainer)

Prediction markets let you bet on yes/no questions like "Will BTC be above $100k by 2026?" You buy YES or NO. If you're right, you win. The AI reads the markets, decides YES or NO (or HOLD), and we place real orders for it.

---

## Why PredictBase? (Base + USDC, No Polygon)

I use **PredictBase** because everything stays on **Base**. Same chain as my wallet. Same USDC. No switching to Polygon or other chains. One place for everything. The agent fetches markets from PredictBase, the AI decides BUY/SELL/HOLD, and we place real limit orders. Trades show up on Base and on Farcaster.

---

## What I Used (The Tech Stack—Simplified)

| What it does | What I used |
|--------------|-------------|
| Runs the code | Node.js + TypeScript |
| Talks to Base | Viem (a library for blockchain) |
| Makes decisions | Anthropic Claude API (an AI) |
| Places trades | PredictBase API (Base + USDC) |
| Posts to Farcaster | Neynar API |
| Stores trades | Supabase (a database) |
| Mints NFTs | A simple smart contract (CrabTradeNFT) |

No website. No React. Just one program and a bunch of settings (called "env vars") that tell it how to connect to everything.

---

## How the Agent Works (Step by Step)

Every few minutes, the same loop runs. Here's what happens:

1. **Health check** — Does my wallet have enough ETH for gas? (Gas = the fee to send transactions)
2. **Fetch markets** — Get the list of prediction markets from PredictBase (questions, YES/NO prices)
3. **Portfolio** — What trades do I have open? What's my P&L? (P&L = profit or loss)
4. **News (optional)** — Pull in some headlines so the AI has extra context
5. **AI analysis** — Send everything to Claude. Claude returns: BUY this, SELL that, or HOLD
6. **Execute** — For each BUY: place a real order on PredictBase, save it in the database, post to Farcaster. For each SELL: close the position, update the database, post to Farcaster
7. **Notable trades → NFTs** — If a closed trade made (or lost) a lot (e.g. 20%+), mint an NFT and post about it
8. **Summaries** — Post a round summary to Farcaster so people see what the bot did
9. **Sleep** — Wait a few minutes (you can set this—e.g. 1 min or 3 min), then do it again

**In one sentence:** The agent fetches markets, asks Claude what to do, places real trades, mints NFTs for big moves, and posts everything to Farcaster.

---

## Setup Guide: What You Need Before You Start

- A **Base wallet** (MetaMask, Coinbase Wallet, etc.)
- An **Anthropic API key** (for Claude—get it at console.anthropic.com)
- A **Supabase project** (free tier is fine—it's a database)
- A **Farcaster account** (e.g. Warpcast) + **Neynar signer** (so the bot can post)
- A **PredictBase API key** (for real trading—get it from PredictBase docs)

Don't worry if some of this sounds new. I'll walk through each part.

---

## Step 1: Get the Code and Install

Open a terminal (or use your code editor's terminal) and run:

```bash
git clone https://github.com/your-username/crab-trader-agent.git
cd crab-trader-agent
npm install
```

`npm install` downloads all the libraries the project needs. This might take a minute.

---

## Step 2: Set Up Your Environment Variables (.env)

Think of env vars as secret settings—API keys, wallet key, etc. The bot needs these to work.

1. Copy `.env.example` to a new file called `.env`
2. Open `.env` in your editor and fill in the values:

**Required (wallet + AI + database):**
```
PRIVATE_KEY=0x...              # Your Base wallet private key (keep this secret!)
ANTHROPIC_API_KEY=sk-ant-...   # From console.anthropic.com
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=your_anon_key
```

**Farcaster (so the bot can post):**
```
NEYNAR_API_KEY=...
FARCASTER_SIGNER_UUID=...
```

**PredictBase (real trading):**
```
USE_PREDICTBASE=true
PREDICTBASE_API_KEY=your_predictbase_api_key
```

**Optional (you can tweak later):**
```
LOOP_INTERVAL_MS=60000         # Run every 1 minute (60000 = 60 seconds)
MAX_POSITION_SIZE=0.05         # Max 5% of portfolio per trade (start small!)
```

**Important:** Don't set `USE_POLYMARKET` or `USE_OPINION_LAB` if you want PredictBase only. Only one market source at a time.

---

## Step 3: Get a PredictBase API Key

1. Go to [PredictBase Docs → Get API Key](https://predictbase.gitbook.io/docs/developer/get-api-key)
2. Follow their steps to request an API key
3. Copy the key and paste it into `.env` as `PREDICTBASE_API_KEY`

---

## Step 4: Fund Your PredictBase Account

Real trades use real USDC. You need to put USDC into your PredictBase account first.

1. Go to [predictbase.app](https://predictbase.app)
2. Connect the **same wallet** as the one you put in `PRIVATE_KEY`
3. Deposit **USDC on Base** into your PredictBase account (they have a deposit flow)

The agent will use this USDC when it places BUY orders.

---

## Step 5: Set Up the Database (Supabase)

The bot stores trades and history in a database. Supabase is free and easy.

1. Go to [supabase.com](https://supabase.com) and create a project
2. Open the SQL Editor in your project
3. Open `database/schema.sql` in the CrabTrader repo and copy its contents
4. Paste into the Supabase SQL Editor and run it
5. Copy your project URL and "anon" key from Supabase → Settings → API
6. Put them in `.env` as `SUPABASE_URL` and `SUPABASE_KEY`

---

## Step 6: Deploy the NFT Contract (Optional)

You can skip this if you don't care about NFTs for notable trades. If you want them:

```bash
npm run deploy:hardhat
```

After it deploys, copy the contract address and add to `.env`:
```
NFT_CONTRACT_ADDRESS=0x...
```

---

## Step 7: Run the Agent

**On your computer:**
```bash
npm run dev
```

You should see logs like: `Market source: PredictBase`, `Fetched X markets`, `Cast posted: 0x...`

**On Railway (so it runs 24/7):**
1. Push your code to GitHub
2. Go to [railway.app](https://railway.app) and connect your repo
3. Add all the same env vars in Railway → Variables
4. Set Build: `npm run build`, Start: `npm start`
5. Deploy

Now the agent runs in the cloud. You can close your laptop.

---

## What You'll See When It Works

- **Logs:** `Market source: PredictBase`, `PredictBase order placed: ...`, `Cast posted: 0x...`
- **Farcaster:** Round summaries, trade entries/exits, market commentary
- **Base:** Real USDC trades on PredictBase, NFT mints if you enabled them

---

## Tips I Learned as a Beginner

1. **Start small** — Use `MAX_POSITION_SIZE=0.02` or `0.05` so each trade is tiny. You can increase later.
2. **Watch the logs** — If something breaks, the logs usually say why. Look for "PredictBase order placed" to confirm real trades.
3. **Faster loops** — `LOOP_INTERVAL_MS=60000` = 1 minute. Default is 3 minutes.
4. **Farcaster not posting?** — Make sure `NEYNAR_API_KEY` and `FARCASTER_SIGNER_UUID` are set. The logs will say "Farcaster posting: ENABLED" if it's working.
5. **"No cached price" warnings** — If you switched from another market (like Polymarket), old positions might show this. They'll clear when the AI closes them or you mark them closed in the database.

---

## What I Learned Along the Way

- **One loop first** — Get the basic loop working (fetch → AI → act → post) before adding NFTs or extras.
- **Structured AI output** — We use Zod so Claude returns valid JSON. That avoids weird parsing bugs and wrong trades.
- **Env vars are everything** — The bot is basically config + code. Write down what each env var does so you (and others) can run it.
- **Deploy early** — Running on Railway made it feel real. I had to fix production issues (Node version, lock file, etc.) and learned a lot.
- **Ask for help** — I had friends to ask. Base, Farcaster, and Twitter builder communities are full of people who want to help.

---

## How You Can Use It

- **Follow my bot** — The Farcaster account posts every round. You'll see what it trades and when.
- **Run your own** — Clone the repo, add your keys, fund PredictBase, deploy. You'll have your own CrabTrader.
- **Change it** — Tweak the prompt, risk rules, or markets. The core loop stays the same.

---

## Quick Checklist (Before You Publish)

- [ ] Clone repo, run `npm install`
- [ ] Add env vars (wallet, Anthropic, Supabase, Neynar, PredictBase)
- [ ] Get PredictBase API key
- [ ] Fund PredictBase with USDC on Base
- [ ] Run Supabase schema
- [ ] (Optional) Deploy NFT contract
- [ ] Run `npm run dev` or deploy to Railway

---

**CrabTrader:** [your Farcaster link]  
**Repo:** [your GitHub link]  
**Built for the OpenClaw Builder Quest on Base.** 🦀

---

*Disclaimer: I'm a beginner. This agent is for learning and experimentation. It uses real USDC and can lose funds. Never risk more than you can afford to lose. The bot does not provide financial advice.*
