.
🦀 CrabTrader Overview
CrabTrader is an autonomous AI agent that:
Trades prediction markets on Base via Limitless Exchange
Mints CrabTrade NFTs on notable wins/losses
Posts live updates to Farcaster (entries, exits, market updates, summaries)
Stores full history in Supabase/Postgres
Runs on Node.js + TypeScript + Claude (Anthropic)
It’s designed to be hands‑off: once configured and funded, it loops forever making decisions, trading, minting NFTs, and talking to the community.
🏗 Architecture
High‑level architecture:
+-----------------------------+|        Farcaster API       || (Neynar signer & casts)    |+--------------+-------------+               ^               |      social posts / replies               |+--------------v-------------+|         CrabTrader         ||  Node.js + TypeScript      ||                             ||  - main loop (src/index.ts) ||  - AI analysis (Claude)     ||  - trading decisions        ||  - NFT minting              |+--------------+--------------+               |               |      onchain txs / reads               |+--------------v-------------+|         Base L2           || - Wallet (viem)           || - CrabTradeNFT contract   || - USDC ERC20              |+--------------+------------+               |               |     market data / orders               |+--------------v-------------+|     Limitless Exchange     ||  - markets API (slugs)     ||  - EIP-712 order signing   |+--------------+-------------+               |               |        state & history               |+--------------v-------------+|      Supabase / Postgres   || - trades                   || - portfolio snapshots      || - social posts & mentions  |+----------------------------+
🧱 How I Built It (Step‑by‑Step)
1. Environment & Project Setup
Installed Node.js 20 and created the project:
  git clone <your-repo-url>  cd crab-trader-agent  npm install
Added TypeScript and config (tsconfig.json).
Created a structured src/ layout:
src/index.ts – main loop
src/ai/* – prompts + analyzer (Claude)
src/blockchain/* – wallet, contracts, trades, tips
src/markets/* – Limitless markets + news
src/social/* – Farcaster + templates
src/database/* – Supabase client + queries
src/utils/* – logger, helpers
2. Smart Contract: CrabTradeNFT
Wrote contracts/CrabTradeNFT.sol using OpenZeppelin:
ERC‑721 with TradeRecord struct (market, position, entry/exit price, P&L, timestamp, commentary).
mintTrade() (onlyOwner) mints NFTs for notable trades.
isNotableTrade() checks if |P&L| > 20%.
Used Hardhat:
npx hardhat compile
Deployed to Base via scripts/deploy-hardhat.js.
Copied the deployed address into .env:
  NFT_CONTRACT_ADDRESS=0x...    # your deployed CrabTradeNFT
3. Wallet & Onchain Integration
Used viem to create a wallet client in src/blockchain/wallet.ts:
Loads PRIVATE_KEY and BASE_RPC_URL from .env.
Exposes getWalletClient(), getWalletAddress(), getBalance().
Implemented NFT helpers in src/blockchain/contracts.ts:
mintTradeNft() calls mintTrade on the NFT contract.
checkNotableTrade() calls isNotableTrade.
4. Database: Supabase / Postgres
Created schema in database/schema.sql:
trades – each entry/exit + P&L + NFT token_id.
portfolio_snapshots – daily value + P&L bps.
social_posts – tweets/casts + type (TRADE_ENTRY, EXIT, NFT_MINT, DAILY_SUMMARY, LAUNCH, REPLY).
mentions – mentions and whether we replied.
Connected via src/database/client.ts using Supabase URL/key.
Implemented typed queries in src/database/queries.ts:
createTrade, updateTrade, getOpenTrades, getAllTrades.
recordSocialPost, recordMention, createPortfolioSnapshot.
5. Market Data & Limitless Integration
Implemented fetchMarkets() in src/markets/fetcher.ts:
Calls https://api.limitless.exchange/markets/active/<CATEGORY_ID> with API key.
Normalizes each market into a PredictionMarket:
id = Limitless slug (from the slug field).
name = human‑readable title.
yesPrice / noPrice in basis points.
Implemented Limitless order signing in src/markets/limitless.ts:
Fetches a single market by slug.
Builds EIP‑712 Order struct (maker, taker, tokenId, maker/taker amounts).
Signs with the bot wallet using signTypedData.
POSTs to /orders with your API key.
Added USDC approve flow in src/blockchain/erc20.ts:
ensureErc20Allowance() checks IERC20 allowance and, if low, sends an approve() to the Limitless exchange contract.
6. AI: Analysis & Decisions
Wrote prompt templates in src/ai/prompts.ts:
Market analysis prompt: takes current markets + news and asks for a small set of decisions (BUY/SELL/HOLD, size, reasoning, confidence).
Reply prompt for mentions (if enabled).
Implemented analyzeMarkets() in src/ai/analyzer.ts:
Calls Anthropic Claude (model from ANTHROPIC_MODEL).
Validates response with a JSON schema, clamps amountEth to a safe range (0.001–0.1 ETH).
Returns a list of normalized trading decisions.
7. Social: Farcaster
Integrated Neynar in src/social/farcaster.ts:
postCastWithRateLimit() posts a cast via signer UUID + API key.
fetchMentions() (optional, can be disabled).
replyToCast() for engagement.
Designed post templates in src/social/templates.ts:
generateTradeEntryPostForPlatform()
generateTradeExitPostForPlatform()
generateDailySummaryForPlatform()
generateMarketReflectionPostForPlatform() (your CRABTRADER MARKET UPDATE style).
Formatting is optimized for Farcaster (blank lines between sections, emojis, short sentences) and optionally trimmed for Twitter.
8. Main Loop
In src/index.ts the loop does:
Health checks
Balance above MIN_ETH_BALANCE.
APIs + config available.
Fetch markets + news
Limitless markets (with slugs).
RSS news feeds.
AI analysis
Send markets + news to Claude.
Get a set of decisions.
Execute trades
For each BUY:
Check ETH balance and max position size.
Resolve correct Limitless slug.
Ensure USDC approve if needed.
Sign + submit order.
Store trade in DB and post entry on Farcaster.
For each SELL:
Look up open trade.
Fetch current price.
Place SELL order via Limitless.
Update trade with P&L and post exit.
NFT minting
Check closed trades for P&L beyond threshold.
checkNotableTrade() on contract.
mintTradeNft() and store token_id.
Social + community
Post market reflection updates and daily summaries.
(Optionally) fetch mentions and reply.
Sleep for LOOP_INTERVAL_MS, then repeat.
🚀 How to Run CrabTrader Yourself
1. Clone & install
git clone <your-repo-url>cd crab-trader-agentnpm install
2. Create .env
Copy .env.example → .env, then fill in:
# Wallet / chainPRIVATE_KEY=0x...                   # bot wallet private key (Base)BASE_RPC_URL=https://mainnet.base.orgNFT_CONTRACT_ADDRESS=0x...          # your deployed CrabTradeNFT# AnthropicANTHROPIC_API_KEY=sk-ant-...ANTHROPIC_MODEL=claude-3-5-sonnet-20240620# Supabase (either DATABASE_URL or URL+KEY)DATABASE_URL=postgres://...# orSUPABASE_URL=...SUPABASE_KEY=...# Farcaster / NeynarNEYNAR_API_KEY=...FARCASTER_SIGNER_UUID=...# LimitlessLIMITLESS_TRADING_ENABLED=false     # start with false (test mode)LIMITLESS_API_BASE_URL=https://api.limitless.exchangeLIMITLESS_CATEGORY_ID=1LIMITLESS_API_KEY=...LIMITLESS_API_KEY_HEADER=X-API-KeyLIMITLESS_API_KEY_PREFIX=LIMITLESS_ORDER_TYPE=GTCLIMITLESS_FEE_RATE_BPS=0LIMITLESS_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913ETH_USD_PRICE=3000# Agent behaviorMIN_ETH_BALANCE=0.01MAX_POSITION_SIZE=0.1STOP_LOSS_BPS=1500TAKE_PROFIT_BPS=3000NOTABLE_TRADE_THRESHOLD_BPS=2000LOOP_INTERVAL_MS=900000# FeaturesDISABLE_MENTIONS=trueDISABLE_TIPS=truePOST_LAUNCH_ANNOUNCEMENT=falseLOG_LEVEL=infoNODE_ENV=production
3. Initialize the database
Run the schema once (e.g. in Supabase SQL editor):
-- From database/schema.sql-- plus any ALTERs you applied during setup
(If you already have the tables, only run the ALTER TABLE steps you need.)
4. Fund the bot
Send ETH on Base to the wallet (for gas + safety).
Send USDC on Base to the same wallet (for real trading) once you’re ready to leave test mode.
5. Run the agent
npm run dev
You should see logs like:
[INFO] Configuration validated[INFO] Wallet initialized: 0x...[INFO] 🦀 CrabTrader agent starting...[INFO] === Starting iteration ===...
Check:
Farcaster: posts from your bot account.
Basescan: ETH + USDC transfers, approvals, and any Limitless‑related txs.
Supabase: rows appearing in trades, social_posts, etc.
🔒 Safety Notes (Test Mode vs Real Trading)
Start in test mode:
  LIMITLESS_TRADING_ENABLED=false
Bot still runs full AI loop, posts to Farcaster, and uses mock trades.
Great for checking behavior without risking USDC.
Switch to real trading carefully:
  LIMITLESS_TRADING_ENABLED=true
Requirements:
Bot wallet has enough ETH for gas and USDC for trades.
LIMITLESS_USDC_ADDRESS is correct for Base.
You understand your MAX_POSITION_SIZE, STOP_LOSS_BPS, TAKE_PROFIT_BPS.
Private key handling
Never commit .env or your PRIVATE_KEY.
Rotate keys if you ever paste them in public.
Prefer a dedicated wallet for the bot, with limited funds.
Run intervals & rate limits
LOOP_INTERVAL_MS controls how often the bot trades.
Use longer intervals (e.g. 15–30 min) to avoid over‑trading or API limits.
