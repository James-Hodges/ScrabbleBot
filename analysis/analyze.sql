-- Analysis queries behind ANALYSIS.md.
-- Run after analysis/pull_data.py:  sqlite3 -header -column data/scrabble.db < analysis/analyze.sql

-- ---------- Derived tables ----------

CREATE INDEX IF NOT EXISTS ar_match ON auction_result(match_id, auction_id);
CREATE INDEX IF NOT EXISTS tb_id ON auction_top_bid_archive(auction_id);
CREATE INDEX IF NOT EXISTS wp_match ON word_play(match_id, bot_id);
CREATE INDEX IF NOT EXISTS mp_match ON match_participant(match_id);

-- Every finished auction with its winning bid and its round number in the match.
DROP TABLE IF EXISTS auc;
CREATE TABLE auc AS
SELECT a.auction_id, a.match_id, a.letter, a.winner_bot_id, a.paid, t.top_bid, a.closed_at,
       ROW_NUMBER() OVER (PARTITION BY a.match_id ORDER BY a.auction_id) AS rnd,
       COUNT(*) OVER (PARTITION BY a.match_id) AS n_rounds
FROM auction_result a
JOIN auction_top_bid_archive t USING (auction_id)
JOIN match_state m ON m.id = a.match_id
WHERE m.status = 'ended';
CREATE INDEX auc_match ON auc(match_id);

-- How many real (non-simulated) bots played in each finished match.
DROP TABLE IF EXISTS mreal;
CREATE TABLE mreal AS
SELECT mp.match_id, SUM(b.is_simulated = 0) AS real_bots, COUNT(*) AS players, MAX(m.created_at) AS created_at
FROM match_participant mp
JOIN bot b ON b.id = mp.bot_id
JOIN match_state m ON m.id = mp.match_id
WHERE m.status = 'ended'
GROUP BY mp.match_id;

-- The sample used throughout: last 3 days, at least 4 real bots.
DROP TABLE IF EXISTS recent2;
CREATE TABLE recent2 AS
SELECT match_id FROM mreal
WHERE real_bots >= 4
  AND created_at >= (SELECT MAX(created_at) FROM mreal) - 3 * 86400 * 1000000;

-- Each bot's finishing place in each sample match.
DROP TABLE IF EXISTS place;
CREATE TABLE place AS
SELECT mp.match_id, mp.bot_id, mp.score, mp.balance,
       1 + (SELECT COUNT(*) FROM match_participant o WHERE o.match_id = mp.match_id AND o.score > mp.score) AS place
FROM match_participant mp JOIN recent2 USING (match_id);

-- Per bot per match: tiles won, coins spent, words, letters played, 7+ letter words.
DROP TABLE IF EXISTS botm;
CREATE TABLE botm AS
SELECT p.match_id, p.bot_id, p.score, p.balance, p.place,
  (SELECT COUNT(*) FROM auc a WHERE a.match_id = p.match_id AND a.winner_bot_id = p.bot_id) AS won,
  (SELECT COALESCE(SUM(paid), 0) FROM auc a WHERE a.match_id = p.match_id AND a.winner_bot_id = p.bot_id) AS spent,
  (SELECT COUNT(*) FROM word_play w WHERE w.match_id = p.match_id AND w.bot_id = p.bot_id) AS words,
  (SELECT COALESCE(SUM(LENGTH(word)), 0) FROM word_play w WHERE w.match_id = p.match_id AND w.bot_id = p.bot_id) AS letters_played,
  (SELECT COALESCE(SUM(LENGTH(word) >= 7), 0) FROM word_play w WHERE w.match_id = p.match_id AND w.bot_id = p.bot_id) AS w7
FROM place p;

-- ---------- 1. Prices by game phase ----------
SELECT CASE WHEN rnd <= 20 THEN '1-20' WHEN rnd <= 48 THEN '21-48' WHEN rnd <= 63 THEN '49-63' ELSE '64-68' END AS phase,
       COUNT(*) AS n, ROUND(AVG(winner_bot_id IS NOT NULL) * 100, 1) AS pct_sold,
       ROUND(AVG(top_bid), 1) AS avg_top, ROUND(AVG(paid), 1) AS avg_paid
FROM auc JOIN recent2 USING (match_id) WHERE n_rounds = 68
GROUP BY phase;

-- ---------- 2. Prices per letter (rounds 1-67, sold only) ----------
WITH x AS (
  SELECT letter, paid, top_bid,
         ROW_NUMBER() OVER (PARTITION BY letter ORDER BY paid) AS rn,
         COUNT(*) OVER (PARTITION BY letter) AS cnt
  FROM auc JOIN recent2 USING (match_id)
  WHERE n_rounds = 68 AND rnd <= 67 AND winner_bot_id IS NOT NULL)
SELECT letter, cnt AS n, ROUND(AVG(top_bid), 1) AS avg_top, ROUND(AVG(paid), 1) AS avg_paid,
       MAX(CASE WHEN rn = cnt / 4 THEN paid END) AS p25,
       MAX(CASE WHEN rn = cnt / 2 THEN paid END) AS med,
       MAX(CASE WHEN rn = cnt * 9 / 10 THEN paid END) AS p90
FROM x GROUP BY letter ORDER BY avg_paid DESC;

-- ---------- 3. Bot leaderboard by average place (20+ sample matches) ----------
SELECT b.name, COUNT(*) AS m, ROUND(AVG(place = 1) * 100) AS win_pct, ROUND(AVG(place), 2) AS avg_place,
       ROUND(AVG(score)) AS score, ROUND(AVG(balance)) AS left_coins, ROUND(AVG(won), 1) AS won,
       ROUND(1.0 * SUM(spent) / MAX(SUM(won), 1), 1) AS per_tile, ROUND(AVG(words), 1) AS words,
       ROUND(1.0 * SUM(letters_played) / MAX(SUM(words), 1), 1) AS avg_len, ROUND(AVG(w7), 1) AS w7
FROM botm JOIN bot b ON b.id = botm.bot_id
WHERE b.is_simulated = 0
GROUP BY botm.bot_id HAVING m >= 20 ORDER BY avg_place;

-- ---------- 4. What separates finishing places ----------
SELECT place, COUNT(*) AS n, ROUND(AVG(score)) AS score, ROUND(AVG(won), 1) AS tiles_won,
       ROUND(1.0 * SUM(spent) / MAX(SUM(won), 1), 1) AS per_tile, ROUND(AVG(spent)) AS spent,
       ROUND(AVG(balance)) AS left_coins, ROUND(AVG(words), 1) AS words,
       ROUND(1.0 * SUM(letters_played) / MAX(SUM(words), 1), 1) AS avg_len, ROUND(AVG(w7), 2) AS w7
FROM botm JOIN bot b ON b.id = botm.bot_id
WHERE b.is_simulated = 0 AND b.name NOT IN ('Afterword', 'hinsonloo')  -- offline bots
GROUP BY place ORDER BY place;

-- ---------- 5. Payoff per tile by word length ----------
SELECT CASE WHEN LENGTH(word) <= 3 THEN '2-3' WHEN LENGTH(word) <= 5 THEN '4-5'
            WHEN LENGTH(word) = 6 THEN '6' WHEN LENGTH(word) = 7 THEN '7' ELSE '8+' END AS len,
       COUNT(*) AS n, ROUND(AVG(total_reward), 1) AS reward,
       ROUND(1.0 * SUM(total_reward) / SUM(LENGTH(word)), 2) AS pts_per_tile
FROM word_play JOIN recent2 USING (match_id) GROUP BY len;
