export interface StrategyV001Config {
  clip_lo: number;
  clip_hi: number;
  min_mc_sol: number;
  max_mc_sol: number;
  timer_ms: number;
  rule_1_enabled: boolean;
  rule_1_size_sol: number;
  rule_1_watch_s: number;
  rule_1_entry_max_s: number;
  rule_1_watch_max_end: number;
  rule_1_skip_entry_mom_s: number;
  rule_1_skip_entry_mom_ge: number;
  rule_1_skip_target_sold_before_buy: boolean;
  rule_1_skip_any_target_second_buy: boolean;
  rule_1_mark_tp: number;
  rule_1_market_buy_exit_sol: number;
  rule_1_market_buy_cum_window_s: number;
  rule_1_dump_stop: number;
  rule_1_dump_grace_s: number;
  rule_1_target_sell_exit: boolean;
  rule_1_target_buy_exit_sol: number;
  rule_2_enabled: boolean;
  rule_2_min_sol: number;
  rule_2_min_profit: number;
  rule_2_size_sol: number;
  rule_2_tp: number;
  rule_2_sl: number;
  rule_2_big_buy_sol: number;
  rule_2_cum_buy_sol: number;
  rule_2_cum_window_s: number;
  rule_2_max_hold_s: number;
  rule_2_buy_slippage_pct: number;
  rule_2_sell_slippage_pct: number;
}

/** Edit strategy knobs here (replaces config/strategy_v_001.json). */
export const STRATEGY_V_001_CONFIG: StrategyV001Config = {
  clip_lo: 2.2,
  clip_hi: 4.8,
  min_mc_sol: 20,
  max_mc_sol: 120,
  timer_ms: 200,

  rule_1_enabled: true,
  rule_1_size_sol: 0.4,
  rule_1_watch_s: 5.5,
  rule_1_entry_max_s: 12,
  rule_1_watch_max_end: 0.28,
  rule_1_skip_entry_mom_s: 1,
  rule_1_skip_entry_mom_ge: 0.02,
  rule_1_skip_target_sold_before_buy: true,
  rule_1_skip_any_target_second_buy: true,
  rule_1_mark_tp: 0.5,
  rule_1_market_buy_exit_sol: 3.5,
  rule_1_market_buy_cum_window_s: 1,
  rule_1_dump_stop: 0.08,
  rule_1_dump_grace_s: 10,
  rule_1_target_sell_exit: false,
  rule_1_target_buy_exit_sol: 0.9,

  rule_2_enabled: false,
  rule_2_min_sol: 2.5,
  rule_2_min_profit: 0.3,
  rule_2_size_sol: 0.5,
  rule_2_tp: 0.25,
  rule_2_sl: 0.15,
  rule_2_big_buy_sol: 1.9,
  rule_2_cum_buy_sol: 4,
  rule_2_cum_window_s: 5,
  rule_2_max_hold_s: 15,
  rule_2_buy_slippage_pct: 50,
  rule_2_sell_slippage_pct: 50
};

export function loadStrategyV001Config(): StrategyV001Config {
  return STRATEGY_V_001_CONFIG;
}
