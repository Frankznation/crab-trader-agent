import { config, validateConfig } from './config/env';
import { logger } from './utils/logger';
import { sleep } from './utils/helpers';
import { initializeWallet, getBalance, hasSufficientBalance, getWalletAddress } from './blockchain/wallet';
import { fetchMarkets } from './markets/fetcher';
import { fetchNewsHeadlines } from './markets/news';
import { analyzeMarkets } from './ai/analyzer';
import { executeTrade, closePosition, getMarketPrice } from './blockchain/trades';
import { sendTip } from './blockchain/tips';
import { createTrade, updateTrade, getOpenTrades, getAllTrades, createPortfolioSnapshot, recordSocialPost, getUnprocessedMentions, markMentionReplied, recordMention } from './database/queries';
import {
  generateTradeEntryPostForPlatform,
  generateTradeExitPostForPlatform,
  generateDailySummaryForPlatform,
  generateMarketReflectionPostForPlatform,
  generateLaunchPostForPlatform,
  generateRoundSummaryForPlatform,
} from './social/templates';
import { postTweetWithRateLimit, fetchMentions as fetchTwitterMentions, replyToTweet } from './social/twitter';
import { postCastWithRateLimit, fetchMentions as fetchFarcasterMentions, replyToCast } from './social/farcaster';
import { processNotableTrades } from './nft/minter';
import { generateReply } from './ai/analyzer';
import { getBasescanAddressUrl, weiToEth } from './utils/helpers';

let isRunning = false;
let lastDailySummary = 0;
const DAILY_SUMMARY_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
let lastTipTime = 0;

function pickTipRecipient(): `0x${string}` | null {
  if (config.disableTips || config.tipRecipients.length === 0) {
    return null;
  }
  const index = Math.floor(Math.random() * config.tipRecipients.length);
  return config.tipRecipients[index] as `0x${string}`;
}

/**
 * Health check - verify wallet balance and system status
 */
async function healthCheck(): Promise<boolean> {
  try {
    const hasBalance = await hasSufficientBalance();
    if (!hasBalance) {
      const balance = await getBalance();
      logger.warn(`Low balance: ${weiToEth(balance)} ETH (minimum: ${config.minEthBalance} ETH)`);
      
      // Post alert to social media
      const alertMessage = `⚠️ Low balance alert: ${weiToEth(balance)} ETH remaining. Need to refuel soon! 🦀`;
      try {
        await postTweetWithRateLimit(alertMessage);
      } catch (error) {
        logger.error(`Failed to post balance alert: ${error}`);
      }
      
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`Health check failed: ${error}`);
    return false;
  }
}

/**
 * Process community mentions and reply
 */
async function processMentions(): Promise<void> {
  if (config.disableMentions) {
    logger.info('Mentions disabled by config');
    return;
  }
  logger.info('Processing community mentions...');

  try {
    // Fetch Twitter mentions
    const twitterMentions = await fetchTwitterMentions();
    for (const mention of twitterMentions) {
      try {
        // Check if already processed
        const existing = await getUnprocessedMentions();
        const alreadyProcessed = existing.some((m) => m.mention_id === mention.id && m.platform === 'TWITTER');
        
        if (!alreadyProcessed) {
          // Record mention
          await recordMention({
            platform: 'TWITTER',
            mention_id: mention.id,
            author: mention.author,
            content: mention.text,
            replied: false,
            timestamp: mention.createdAt,
          });

          // Generate AI reply
          const reply = await generateReply(mention.text);
          
          // Reply to mention
          const replyId = await replyToTweet(mention.id, reply);
          
          // Mark as replied
          const mentions = await getUnprocessedMentions();
          const dbMention = mentions.find((m) => m.mention_id === mention.id);
          if (dbMention) {
            await markMentionReplied(dbMention.id, replyId);
          }

          await recordSocialPost({
            platform: 'TWITTER',
            post_id: replyId,
            content: reply,
            post_type: 'REPLY',
            timestamp: new Date(),
          });

          logger.info(`Replied to Twitter mention: ${mention.id}`);
          await sleep(2000); // Rate limiting
        }
      } catch (error) {
        logger.error(`Failed to process Twitter mention ${mention.id}: ${error}`);
      }
    }

    // Fetch Farcaster mentions
    const farcasterMentions = await fetchFarcasterMentions();
    for (const mention of farcasterMentions) {
      try {
        const existing = await getUnprocessedMentions();
        const alreadyProcessed = existing.some((m) => m.mention_id === mention.hash && m.platform === 'FARCASTER');
        
        if (!alreadyProcessed) {
          await recordMention({
            platform: 'FARCASTER',
            mention_id: mention.hash,
            author: mention.author,
            content: mention.text,
            replied: false,
            timestamp: new Date(mention.timestamp),
          });

          const reply = await generateReply(mention.text);
          const replyHash = await replyToCast(mention.hash, reply);
          
          const mentions = await getUnprocessedMentions();
          const dbMention = mentions.find((m) => m.mention_id === mention.hash);
          if (dbMention) {
            await markMentionReplied(dbMention.id, replyHash);
          }

          await recordSocialPost({
            platform: 'FARCASTER',
            post_id: replyHash,
            content: reply,
            post_type: 'REPLY',
            timestamp: new Date(),
          });

          logger.info(`Replied to Farcaster mention: ${mention.hash}`);
          await sleep(2000);
        }
      } catch (error) {
        logger.error(`Failed to process Farcaster mention ${mention.hash}: ${error}`);
      }
    }
  } catch (error) {
    logger.error(`Failed to process mentions: ${error}`);
  }
}

/**
 * Execute trading decisions
 */
async function executeTradingDecisions(decisions: Array<{
  action: 'BUY' | 'SELL' | 'HOLD';
  marketId: string;
  marketName: string;
  position: 'YES' | 'NO';
  amountEth: number;
  reasoning: string;
  confidence: number;
}>, marketPrices: Map<string, { yesPrice: number; noPrice: number }>): Promise<number> {
  logger.info(`Executing ${decisions.length} trading decisions...`);
  let executed = 0;
  let skipped = 0;
  for (const decision of decisions) {
    if (decision.action === 'HOLD') {
      skipped++;
      logger.debug(`Skipping HOLD decision for ${decision.marketName}`);
      continue;
    }
    
    logger.info(`Processing ${decision.action} decision: ${decision.marketName} - ${decision.position} - ${decision.amountEth} ETH`);

    try {
      if (decision.action === 'BUY') {
        const priceSnapshot = marketPrices.get(decision.marketId);
        const expectedPrice = decision.position === 'YES'
          ? priceSnapshot?.yesPrice
          : priceSnapshot?.noPrice;

        // Execute new trade
        const amountUsd = decision.amountEth * config.ethUsdPrice;
        const result = await executeTrade({
          marketId: decision.marketId,
          marketName: decision.marketName,
          position: decision.position,
          amountEth: decision.amountEth,
          expectedPrice: expectedPrice ?? 5000,
        });

        // Use resolved slug as market_id so getMarketPrice and closePosition work
        const marketIdForDb = result.resolvedMarketId ?? decision.marketId;

        // Record in database
        const trade = await createTrade({
          market_id: marketIdForDb,
          market_name: decision.marketName,
          position: decision.position,
          amount_eth: decision.amountEth,
          amount_usd: amountUsd,
          entry_price: result.actualPrice,
          entry_tx_hash: result.txHash,
          entry_timestamp: new Date(result.timestamp),
          status: 'OPEN',
        });

        // Post to social media
        const postParams = {
          marketName: decision.marketName,
          position: decision.position,
          amountEth: decision.amountEth,
          price: result.actualPrice,
          txHash: result.txHash,
          reasoning: decision.reasoning,
          confidence: decision.confidence,
          timestamp: result.timestamp,
        };

        try {
          const tweetContent = generateTradeEntryPostForPlatform(postParams, 'TWITTER');
          const tweetId = await postTweetWithRateLimit(tweetContent);
          if (tweetId) {
            await recordSocialPost({
              platform: 'TWITTER',
              post_id: tweetId,
              content: tweetContent,
              post_type: 'TRADE_ENTRY',
              related_trade_id: trade.id,
              timestamp: new Date(),
            });
          }
        } catch (error) {
          logger.error(`Failed to post trade entry tweet: ${error}`);
        }

        try {
          const castContent = generateTradeEntryPostForPlatform(postParams, 'FARCASTER');
          const castHash = await postCastWithRateLimit(castContent);
          await recordSocialPost({
            platform: 'FARCASTER',
            post_id: castHash,
            content: castContent,
            post_type: 'TRADE_ENTRY',
            related_trade_id: trade.id,
            timestamp: new Date(),
          });
        } catch (error) {
          logger.error(`Failed to post trade entry cast: ${error}`);
        }

        executed += 1;
        logger.info(`Trade opened: ${decision.marketName} - ${decision.position}`);
      } else if (decision.action === 'SELL') {
        // Close existing position
        const openTrades = await getOpenTrades();
        const tradeToClose = openTrades.find((t) => t.market_id === decision.marketId);
        
        if (tradeToClose) {
          const currentPrice = await getMarketPrice(decision.marketId, tradeToClose.position);
          const amountUsd = tradeToClose.amount_usd
            ?? (tradeToClose.amount_eth !== undefined
              ? tradeToClose.amount_eth * config.ethUsdPrice
              : decision.amountEth * config.ethUsdPrice);
          const result = await closePosition(
            tradeToClose.market_name,
            tradeToClose.position,
            tradeToClose.entry_price,
            currentPrice,
            amountUsd,
            tradeToClose.market_id
          );

          const pnlBps = Math.round(((currentPrice - tradeToClose.entry_price) / tradeToClose.entry_price) * 10000);

          // Update trade
          await updateTrade(tradeToClose.id, {
            exit_price: currentPrice,
            exit_tx_hash: result.txHash,
            exit_timestamp: new Date(result.timestamp),
            pnl_bps: pnlBps,
            status: 'CLOSED',
          });

          const exitReason = pnlBps <= -config.stopLossBps
            ? 'Stop-loss risk control hit.'
            : pnlBps >= config.takeProfitBps
              ? 'Take-profit rule triggered.'
              : 'Signal shifted; trimming risk.';

          // Post to social media
          const postParams = {
            marketName: tradeToClose.market_name,
            position: tradeToClose.position,
            entryPrice: tradeToClose.entry_price,
            exitPrice: currentPrice,
            pnlBps,
            amountEth: 0.1, // Placeholder
            txHash: result.txHash,
            timestamp: result.timestamp,
            exitReason,
          };

          try {
            const tweetContent = generateTradeExitPostForPlatform(postParams, 'TWITTER');
            const tweetId = await postTweetWithRateLimit(tweetContent);
            if (tweetId) {
              await recordSocialPost({
                platform: 'TWITTER',
                post_id: tweetId,
                content: tweetContent,
                post_type: 'TRADE_EXIT',
                related_trade_id: tradeToClose.id,
                timestamp: new Date(),
              });
            }
          } catch (error) {
            logger.error(`Failed to post trade exit tweet: ${error}`);
          }

          try {
            const castContent = generateTradeExitPostForPlatform(postParams, 'FARCASTER');
            const castHash = await postCastWithRateLimit(castContent);
            await recordSocialPost({
              platform: 'FARCASTER',
              post_id: castHash,
              content: castContent,
              post_type: 'TRADE_EXIT',
              related_trade_id: tradeToClose.id,
              timestamp: new Date(),
            });
          } catch (error) {
            logger.error(`Failed to post trade exit cast: ${error}`);
          }

          executed += 1;
          logger.info(`Trade closed: ${tradeToClose.market_name} - P&L: ${pnlBps} bps`);
        }
      }
    } catch (error) {
      logger.error(`Failed to execute trade decision: ${error}`);
    }
  }
  logger.info(`Trade execution summary: ${executed} executed, ${skipped} skipped (HOLD), ${decisions.length - executed - skipped} failed`);
  return executed;
}

/**
 * Post daily summary
 */
async function postDailySummary(): Promise<void> {
  const now = Date.now();
  if (now - lastDailySummary < DAILY_SUMMARY_INTERVAL) {
    return;
  }

  logger.info('Posting daily summary...');

  try {
    const balance = await getBalance();
    const totalValue = weiToEth(balance);
    const openTrades = await getOpenTrades();
    const allTrades = await getAllTrades(100);
    
    // Calculate daily P&L (simplified)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tradesToday = allTrades.filter((t) => t.entry_timestamp >= today);
    const dailyPnlBps = tradesToday.reduce((sum, t) => sum + (t.pnl_bps || 0), 0);

    const summaryParams = {
      totalValue,
      dailyPnlBps,
      tradesToday: tradesToday.length,
      openPositions: openTrades.length,
    };

    try {
      const tweetContent = generateDailySummaryForPlatform(summaryParams, 'TWITTER');
      const tweetId = await postTweetWithRateLimit(tweetContent);
      if (tweetId) {
        await recordSocialPost({
          platform: 'TWITTER',
          post_id: tweetId,
          content: tweetContent,
          post_type: 'DAILY_SUMMARY',
          timestamp: new Date(),
        });
      }
    } catch (error) {
      logger.error(`Failed to post daily summary tweet: ${error}`);
    }

    try {
      const castContent = generateDailySummaryForPlatform(summaryParams, 'FARCASTER');
      const castHash = await postCastWithRateLimit(castContent);
      await recordSocialPost({
        platform: 'FARCASTER',
        post_id: castHash,
        content: castContent,
        post_type: 'DAILY_SUMMARY',
        timestamp: new Date(),
      });
    } catch (error) {
      logger.error(`Failed to post daily summary cast: ${error}`);
    }

    // Create portfolio snapshot
    await createPortfolioSnapshot({
      timestamp: new Date(),
      total_value_eth: totalValue,
      open_positions_count: openTrades.length,
      daily_pnl_bps: dailyPnlBps,
    });

    lastDailySummary = now;
    logger.info('Daily summary posted');
  } catch (error) {
    logger.error(`Failed to post daily summary: ${error}`);
  }
}

/**
 * Run a single agent iteration (health check → markets → AI → trades → NFTs → social).
 * Used by both the long-running loop and Vercel cron.
 */
export async function runOneIteration(): Promise<{ ok: boolean; message: string }> {
  try {
    logger.info('=== Starting iteration ===');

    const healthy = await healthCheck();
    if (!healthy) {
      logger.warn('Health check failed, skipping iteration');
      return { ok: false, message: 'Health check failed' };
    }

    const marketData = await fetchMarkets();
    logger.info(`Fetched ${marketData.markets.length} markets`);

    const balance = await getBalance();
    const portfolioValue = weiToEth(balance);
    const openTrades = await getOpenTrades();

    const openPositionsWithPrices = await Promise.all(
      openTrades.map(async (trade) => {
        const currentPrice = await getMarketPrice(trade.market_id, trade.position);
        const pnlBps = Math.round(((currentPrice - trade.entry_price) / trade.entry_price) * 10000);
        return {
          marketId: trade.market_id,
          marketName: trade.market_name,
          position: trade.position,
          entryPrice: trade.entry_price,
          currentPrice,
          pnlBps,
        };
      })
    );

    const headlines = await fetchNewsHeadlines(5);
    const newsContext = headlines.map((h) => h.title);

    const analysis = await analyzeMarkets(
      portfolioValue,
      openPositionsWithPrices,
      marketData.markets.map((m) => ({
        id: m.id,
        name: m.name,
        yesPrice: m.yesPrice,
        noPrice: m.noPrice,
        volume24h: m.volume24h,
      })),
      newsContext
    );

    logger.info(
      `AI generated ${analysis.decisions.length} decisions:`,
      analysis.decisions.map((d) => `${d.action} ${d.marketName} ${d.position} ${d.amountEth}ETH`).join(', ')
    );

    if (analysis.marketCommentary) {
      try {
        const reflection = generateMarketReflectionPostForPlatform(
          {
            commentary: analysis.marketCommentary,
            riskAssessment: analysis.riskAssessment,
            portfolioRecommendation: analysis.portfolioRecommendation,
            timestamp: Date.now(),
          },
          'TWITTER'
        );
        await postTweetWithRateLimit(reflection);
      } catch (error) {
        logger.error(`Failed to post commentary: ${error}`);
      }
      try {
        const castContent = generateMarketReflectionPostForPlatform(
          {
            commentary: analysis.marketCommentary,
            riskAssessment: analysis.riskAssessment,
            portfolioRecommendation: analysis.portfolioRecommendation,
            timestamp: Date.now(),
          },
          'FARCASTER'
        );
        await postCastWithRateLimit(castContent);
      } catch (error) {
        logger.error(`Failed to post commentary cast: ${error}`);
      }
    }

    const priceMap = new Map(
      marketData.markets.map((m) => [m.id, { yesPrice: m.yesPrice, noPrice: m.noPrice }])
    );
    const tradesExecuted = await executeTradingDecisions(analysis.decisions, priceMap);
    logger.info(`✅ Iteration summary: ${tradesExecuted} trades executed`);

    await processNotableTrades();
    await processMentions();
    await postDailySummary();

    try {
      if (!config.farcaster.signerUuid) {
        logger.warn('Skipping Farcaster round summary: FARCASTER_SIGNER_UUID not set');
      } else {
        const roundParams = {
          portfolioEth: portfolioValue,
          openPositions: openTrades.length,
          marketsScanned: marketData.markets.length,
          decisionsCount: analysis.decisions.length,
          tradesExecuted,
          hasCommentary: Boolean(analysis.marketCommentary?.trim()),
        };
        const castContent = generateRoundSummaryForPlatform(roundParams, 'FARCASTER');
        logger.info('Posting round summary to Farcaster...');
        await postCastWithRateLimit(castContent);
        logger.info('Round summary posted to Farcaster');
      }
    } catch (roundErr) {
      logger.error(`Failed to post round summary: ${roundErr}`);
    }

    const now = Date.now();
    if (!config.disableTips && now - lastTipTime >= config.tipIntervalMs) {
      const recipient = pickTipRecipient();
      if (recipient) {
        try {
          await sendTip(recipient, config.tipAmountEth);
          lastTipTime = now;
        } catch (error) {
          logger.error(`Failed to send tip: ${error}`);
        }
      }
    }

    logger.info('=== Iteration complete ===');
    return { ok: true, message: 'Iteration complete' };
  } catch (error) {
    logger.error(`Error in iteration: ${error}`);
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run the agent once (validate config, init wallet, run one iteration).
 * Use this for Vercel cron or other serverless triggers.
 */
export async function runAgentOnce(): Promise<{ ok: boolean; message: string }> {
  validateConfig();
  initializeWallet();
  return runOneIteration();
}

/**
 * Main autonomous loop (for local or long-running process)
 */
async function autonomousLoop(): Promise<void> {
  logger.info('🦀 CrabTrader agent starting...');
  logger.info(`Loop interval: ${config.loopIntervalMs / 1000}s`);
  logger.info(`Market source: ${config.usePredictBase ? 'PredictBase' : config.usePolymarket ? 'Polymarket' : config.useOpinionLab ? 'Opinion Lab' : 'Limitless'}`);
  if (config.usePredictBase) {
    logger.info('PredictBase real trading: ON');
  } else if (config.usePolymarket) {
    logger.info(`Polymarket real trading: ${config.polymarketTradingEnabled ? 'ON' : 'OFF (mock only)'}`);
  } else if (!config.useOpinionLab) {
    logger.info(`Limitless real trading: ${config.limitlessTradingEnabled ? 'ON' : 'OFF (mock only)'}`);
  }

  while (isRunning) {
    await runOneIteration();
    await sleep(config.loopIntervalMs);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    // Validate configuration
    validateConfig();
    logger.info('Configuration validated');

    // Initialize wallet
    initializeWallet();
    logger.info('Wallet initialized');

    if (config.farcaster.signerUuid) {
      logger.info('Farcaster posting: ENABLED (FARCASTER_SIGNER_UUID set)');
    } else {
      logger.warn('Farcaster posting: DISABLED — set FARCASTER_SIGNER_UUID in env to post casts');
    }

    // Optional launch announcement
    if (config.postLaunchAnnouncement) {
      const walletUrl = getBasescanAddressUrl(getWalletAddress());
      const launchParams = { walletAddress: walletUrl };
      try {
        const tweetContent = generateLaunchPostForPlatform(launchParams, 'TWITTER');
        const tweetId = await postTweetWithRateLimit(tweetContent);
        if (tweetId) {
          await recordSocialPost({
            platform: 'TWITTER',
            post_id: tweetId,
            content: tweetContent,
            post_type: 'LAUNCH',
            timestamp: new Date(),
          });
        }
      } catch (error) {
        logger.error(`Failed to post launch tweet: ${error}`);
      }

      try {
        const castContent = generateLaunchPostForPlatform(launchParams, 'FARCASTER');
        const castHash = await postCastWithRateLimit(castContent);
        await recordSocialPost({
          platform: 'FARCASTER',
          post_id: castHash,
          content: castContent,
          post_type: 'LAUNCH',
          timestamp: new Date(),
        });
      } catch (error) {
        logger.error(`Failed to post launch cast: ${error}`);
      }
    }

    // Start autonomous loop
    isRunning = true;
    await autonomousLoop();
  } catch (error) {
    logger.error(`Fatal error: ${error}`);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  isRunning = false;
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  isRunning = false;
  process.exit(0);
});

// Start the agent
if (require.main === module) {
  main().catch((error) => {
    logger.error(`Unhandled error: ${error}`);
    process.exit(1);
  });
}
