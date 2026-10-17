# ShadRox — Pricing & Unit-Economics Model

**Version:** 2.0
**Date:** 17 Oct 2026
**Currency:** INR (₹) · FX assumption ₹89 / USD
**Status:** Pricing model only. Caps exist in the UI but are **client-side only** — no server enforcement, no database, no billing.

---

## 0. TL;DR

| | |
|---|---|
| Final sticker prices | Free ₹0 · **Pro ₹499/mo** · Adv ₹1,099/mo · Enterprise Custom (list ₹24,999) |
| Monthly message caps | Free **100** · Pro **250** · Adv **500** · Enterprise 5,000 |
| Pro net revenue after GST + gateway | **₹411.10** per user per month |
| Pro AI token cost (active user, 250 msg) | **₹56.96** |
| Pro gross profit / user | **₹354.14** (86.1% of net revenue) |
| Fixed infra cost | **₹1,863 / month** |
| Break-even | **6 paying Pro users** |
| Realistic scenario (500 Pro + 100 Adv + 1 Enterprise) | **₹2,64,974 net profit / month (₹31.8 lakh / year)** |
| Market position | Pro **44% cheaper** than GitHub Copilot; Adv sits **above** Copilot Individual |
| Biggest risk | Caps are **not enforceable today** — `localStorage` only, trivially bypassed |
| Biggest structural question | Adv's effective price **per message is higher** than Pro's (₹1.81 vs ₹1.64) |

---

## 1. Assumptions register

Every number in this document is derived from the constants below. **If you want to break the model, attack this table first.**

### 1.1 Token rates (USD per 1M tokens, on-demand)

| Model key | Model | Input | Output | Role |
|---|---|---|---|---|
| `instant` | Llama 3.1 8B Instant | $0.05 | $0.08 | cheapest available |
| `scout` | Llama 4 Scout 17B | $0.11 | $0.34 | **Pro/Adv default** |
| `llama70b` | Llama 3.3 70B Versatile | $0.59 | $0.79 | premium fast tier |
| `gflash` | Gemini 3 Flash | $0.50 | $3.00 | premium (Adv) |

> **Verification needed:** these are the rates the model was built on (provider pricing pages, Oct 2026). Re-check before launching — a 20% rate change moves Pro gross margin by ~3 percentage points.

### 1.2 Other constants

| Constant | Value | Note |
|---|---|---|
| USD → INR | 89 | sensitivity tested in §7.1 |
| GST | 18% | treated as **inclusive** in the sticker price, carved out |
| Payment gateway | 2.36% | Razorpay/Stripe domestic card |
| Fixed infra | ₹1,863 / mo | Vercel Pro ₹1,780 + domain ₹83 amortised |
| Supabase | ₹0 today | free tier; **+₹2,225/mo once the server-side meter ships** |
| Cost-fix token factor | 0.5 | history trim + repo-map cache assumed to halve token spend |

### 1.3 Per-turn token profile (the single most important assumption)

ShadRox's cost per turn is high because the request shape is heavy:

- **Input:** repo map (~6,000 chars, `REPO_MAP_MAX_CHARS`) + BM25-retrieved chunks (budget = `contextWindow × 2` chars) + **the entire chat history, re-sent every turn**
- **Output:** because of the fence-based file edit protocol (```` ```tsx path=src/App.tsx ````), the model rewrites **the whole file**, not a diff

| Profile | Input tokens | Output tokens |
|---|---|---|
| Light | 6,000 | 1,500 |
| Normal | 14,000 | 3,000 |
| Heavy | 35,000 | 8,000 |

> **Verification needed:** these are **estimates derived from the request-building code**, not measurements. Instrument one week of real traffic and replace this table with measured p50/p95. This is the highest-leverage validation available.

### 1.4 Usage bands (messages per paying user per month)

| Band | Messages | Implied |
|---|---|---|
| Casual | 150 | ~5 msg/day |
| Active | 250 | ~8 msg/day |
| Power | 500+ | beyond both paid caps |

**Active (250) is the default everywhere below.** Note the caps now sit at 250 (Pro) and 500 (Adv), so "casual" and "active" both consume most of the Pro allowance.

---

## 2. Cost per message

Formula:

```
cost_per_message = ((input_tokens × input_rate) + (output_tokens × output_rate)) / 1,000,000 × FX
```

| Model | Light | Normal | Heavy |
|---|---|---|---|
| Llama 3.1 8B Instant | ₹0.04 | ₹0.08 | ₹0.21 |
| **Llama 4 Scout** | ₹0.10 | **₹0.23** | ₹0.58 |
| Llama 3.3 70B Versatile | ₹0.42 | ₹0.95 | ₹2.40 |
| Gemini 3 Flash | ₹0.67 | ₹1.42 | ₹3.69 |

**Cost split insight:** on Scout/Normal, input is ₹0.14 and output is ₹0.09 of the ₹0.23 total — **output is 40% of cost** even though it is under a quarter of the tokens. Output is priced ~3x input. This is why the "rewrite the whole file" protocol is so expensive.

**Decision that follows:** the shared-key default is **Llama 4 Scout**. On 70B (₹0.95/turn) a 250-message Pro user costs ₹237/mo against ₹411 net revenue — survivable, but it halves the margin for no pricing gain. Scout is the model the ₹499 price is built on.

---

## 3. Price → net revenue

Sticker prices are GST-inclusive (Indian market standard). Money flows out in three hops:

```
Pro:  ₹499.00  user pays
     −₹76.12  GST 18% (govt's, not yours)
     −₹11.78  payment gateway 2.36%
     ─────────
    =₹411.10  net revenue  ← the only real revenue line
```

Full ladder:

| | Free | Pro | Adv | Enterprise |
|---|---|---|---|---|
| Sticker | ₹0 | ₹499 | ₹1,099 | ₹24,999 (list) |
| GST carved out | ₹0 | ₹76.12 | ₹167.64 | ₹3,813.41 |
| Gateway 2.36% | ₹0 | ₹11.78 | ₹25.94 | ₹589.98 |
| **Net revenue** | **₹0** | **₹411.10** | **₹905.42** | **₹20,595.61** |

**Ladder shape:** Adv is 2.20x Pro in price for 2.00x the messages. A near-linear ladder like this is easy to explain but leaves no room for a future "Pro+" tier between them; if one is ever added it will have to squeeze into ₹700–₹900.

---

## 4. Per-plan unit economics

### Free (BYOK) — 100 message cap

| Line | Value |
|---|---|
| Net revenue | ₹0 |
| AI token cost | ₹0 (user's own key) |
| ShadRox's cost | Only Vercel function seconds |
| Gross profit | ₹0 — **deliberate** |
| Cap | 100 messages / calendar month |

**Important framing:** the 100-message cap does **not** save ShadRox money — BYOK means the user pays for tokens, so ShadRox's marginal cost is ₹0 at 100 messages and at 100,000 messages alike. The cap exists purely as an **upgrade lever**: it makes the free tier feel finite so a share of users convert to Pro.

That makes the cap a *marketing* decision, not a cost decision, and it should be judged on conversion rate alone. Its only real cost is funnel friction.

A second consequence: because the counter lives in `localStorage`, the cap delivers the friction but **not the enforcement**. A user who clears site data — or calls the API directly — gets unlimited free usage. So today ShadRox pays the conversion cost of a cap without gaining the protection of one. Either enforce it server-side or remove it.

### Pro — ₹499, cap 250 messages

| Line | Value |
|---|---|
| Net revenue | ₹411.10 |
| AI cost @ 250 msg (Scout, normal) | ₹56.96 |
| **Gross profit** | **₹354.14** |
| **Gross margin** (on net revenue) | **86.1%** |

Margin across profiles and usage:

| Scenario | msgs | AI cost | Gross profit | Margin |
|---|---|---|---|---|
| Casual, light turns | 150 | ₹15.62 | ₹395.48 | 96.2% |
| Active, normal turns | 250 | ₹56.96 | ₹354.14 | 86.1% |
| Full cap, all normal | 250 | ₹56.96 | ₹354.14 | 86.1% |
| Full cap, all **heavy** turns | 250 | ₹146.18 | ₹264.92 | 64.4% |
| Full cap on **70B**, normal | 250 | ₹236.52 | ₹174.58 | 42.5% |
| Full cap on **70B**, heavy | 250 | **₹600.08** | **−₹188.98** | **loss** ⚠️ |

**The 250 cap removes the worst risk.** At the previous 600-message configuration a heavy user produced a loss even on the cheap model. At 250 messages, all-heavy on Scout still leaves **64.4% margin**. The cap is doing real work here — it is not just a marketing number.

Break-even usage (normal profile): ₹411.10 ÷ ₹0.22784 = **1,804 messages**, i.e. a **7.2x buffer** over the 250 cap. This is a very comfortable safety margin.

The remaining loss scenario needs **premium models selectable on Pro** *and* heavy turns. Since the shared key is gated by `classifyTier` and Pro's catalog defaults to Scout, this should not be reachable — but it must stay gated.

### Adv — ₹1,099, cap 500 messages

Assumed model mix: ~10% of metered messages on the premium model (Gemini 3 Flash), 90% on Scout.

| Line | Value |
|---|---|
| Net revenue | ₹905.42 |
| AI cost @ 500 msg (450 Scout + 50 Flash, normal) | ₹173.73 |
| **Gross profit** | **₹731.69** |
| **Gross margin** | **80.8%** |
| AI cost, all fast at cap | ₹113.92 |
| Gross profit, all fast at cap | ₹791.50 (87.4%) |
| AI cost, all **heavy** at cap | ₹292.37 |
| Gross profit, all heavy at cap | ₹613.05 (67.7%) |

Adv is safe at the cap on every realistic mix, including all-heavy. The only loss case is "500 messages, all premium *and* all heavy" (₹1,846.75 cost), which would require a user to exclusively use Gemini 3 Flash at maximum context — not a realistic profile, but worth a server-side token budget later.

**Structural question to review:** Adv's effective **net price per message is ₹1.81, while Pro's is ₹1.64**. A buyer comparing ₹/message sees Adv as *worse* value, not better. Adv is defensible today because it also unlocks premium models and a larger context — but if the premium tier is not visibly better in the product, the ladder reads as a price increase rather than an upgrade. Options: broaden the Pro→Adv gap (e.g. Adv 750 messages), or make the premium models an explicitly named Adv feature in the UI.

### Enterprise — Custom (list ₹24,999)

| Line | Value |
|---|---|
| Net revenue | ₹20,595.61 |
| AI cost (assumed ~10 seats, normal usage) | ₹4,000 |
| **Gross profit** | **₹16,595.61** |

The most speculative number in the model — it depends entirely on real deal terms, seat count, and whether SSO / audit log / secrets-vault features actually exist (they do not yet). Treat ₹24,999 as a **list anchor**, not a forecast.

---

## 5. Fixed cost & break-even

| Item | ₹/mo |
|---|---|
| Vercel Pro | 1,780 |
| Domain (₹1,000/yr amortised) | 83 |
| Supabase | 0 |
| **Total** | **1,863** |

Break-even = ₹1,863 ÷ ₹354.14 = **5.26 → 6 Pro users.**

After 6 users every additional Pro user is nearly pure profit, because the architecture is serverless + BYOK — **infrastructure cost does not scale with users**. This is the single biggest reason ShadRox can price below the market.

> When the usage meter ships, Supabase goes to ~₹2,225/mo → fixed ₹4,088 → break-even rises to **12 Pro users**. Still trivial, but plan for it.

---

## 6. Scale scenarios

### 6.1 Conservative floor — Pro only, active usage, no cost fixes

| Pro users | GMV | GST | Gateway | Net revenue | AI cost | Fixed | **Net profit / mo** | Net profit / yr |
|---|---|---|---|---|---|---|---|---|
| 100 | ₹49,900 | ₹7,612 | ₹1,178 | ₹41,110 | ₹5,696 | ₹1,863 | ₹33,551 | ₹4.03 L |
| 250 | ₹1,24,750 | ₹19,030 | ₹2,944 | ₹1,02,776 | ₹14,240 | ₹1,863 | ₹86,673 | ₹10.40 L |
| 500 | ₹2,49,500 | ₹38,059 | ₹5,888 | ₹2,05,552 | ₹28,480 | ₹1,863 | ₹1,75,209 | ₹21.03 L |
| 1,000 | ₹4,99,000 | ₹76,119 | ₹11,776 | ₹4,11,105 | ₹56,960 | ₹1,863 | ₹3,52,282 | ₹42.27 L |
| 2,500 | ₹12,47,500 | ₹1,90,297 | ₹29,441 | ₹10,27,762 | ₹1,42,400 | ₹1,863 | ₹8,83,499 | ₹1.06 Cr |
| 5,000 | ₹24,95,000 | ₹3,80,594 | ₹58,882 | ₹20,55,524 | ₹2,84,800 | ₹1,863 | **₹17,68,861** | **₹2.12 Cr** |

### 6.2 Realistic mix — 500 Pro + 100 Adv + 1 Enterprise, active, no fixes

| Line item | Amount / month | % of GMV |
|---|---|---|
| GMV (users paid) | ₹3,84,399 | 100% |
| − GST (18%, inclusive) | −₹58,637 | 15.3% |
| − Payment gateway (2.36%) | −₹9,072 | 2.4% |
| − AI token cost | −₹49,853 | 13.0% |
| − Fixed infra | −₹1,863 | 0.5% |
| **= Net profit (in the pocket)** | **₹2,64,974** | **68.9%** |

That is **₹31.8 lakh per year** at 600 paying users — and the numbers hold even if every one of them is an active daily user.

### 6.3 Same mix WITH the cost fixes (history trim + repo-map cache, ~50% token cut)

| | Token cost | Net profit / mo |
|---|---|---|
| Today | ₹49,853 | ₹2,64,974 |
| After fixes | ₹24,927 | **₹2,89,900** |

Marginal gain at 5,000 Pro users: **+₹1,42,400/mo (₹17 L/yr)**. These fixes are **pure upside and not yet built** — do not price them in today.

---

## 7. Sensitivity analysis

### 7.1 FX (USD → INR)

| FX | Pro AI cost/user | Pro gross profit | Margin |
|---|---|---|---|
| 85 | ₹54.41 | ₹356.69 | 86.8% |
| **89 (base)** | **₹56.96** | **₹354.14** | **86.1%** |
| 95 | ₹60.80 | ₹350.30 | 85.2% |
| 100 | ₹64.00 | ₹347.10 | 84.4% |

A 12% rupee slide costs **1.7 margin points**. FX is a rounding error compared to usage behaviour.

### 7.2 Usage behaviour — the real variable

Fix Pro at ₹499 and cap 250:

| Scenario | AI cost/user | Gross profit | Margin |
|---|---|---|---|
| Everyone casual, light turns | ₹15.62 | ₹395.48 | 96.2% |
| Everyone active, normal turns | ₹56.96 | ₹354.14 | 86.1% |
| Everyone at cap, normal turns | ₹56.96 | ₹354.14 | 86.1% |
| Everyone at cap, heavy turns | ₹146.18 | ₹264.92 | 64.4% |
| Everyone at cap, heavy turns on `instant` routing | ₹53.18 | ₹357.92 | 87.1% |

**Read:** with a 250 cap, the model is robust to both volume *and* turn size. This is a materially safer configuration than a 600 cap. The lever to watch is no longer "how many messages" — it is "which model", and that is already gated.

### 7.3 Model mix

If Pro users could select 70B:

| Pro usage on 70B | AI cost/user | Gross profit | Margin |
|---|---|---|---|
| 150 msg | ₹141.90 | ₹269.20 | 65.5% |
| 250 msg (full cap) | ₹236.52 | ₹174.58 | 42.5% |
| 250 msg, heavy turns | ₹600.08 | **−₹188.98** | **loss** |

**Conclusion: premium models must never be selectable on the Pro plan.** This is the second reason Scout is the default and the reason the shared-key catalog must stay gated server-side.

---

## 8. Market position

| Product | Price/mo | Pro (₹499) | Adv (₹1,099) |
|---|---|---|---|
| **GitHub Copilot Individual** | ₹890 ($10) | **44% cheaper** | **23% costlier** |
| GitHub Copilot Business | ₹1,691 ($19) | 70% cheaper | 35% cheaper |
| Windsurf Pro | ₹1,335 ($15) | 63% cheaper | 18% cheaper |
| Cursor Pro | ₹1,780 ($20) | 72% cheaper | 38% cheaper |

**Honest read:** Pro is clearly below market on every comparison. Adv is **not** — it is priced above Copilot Individual and competes instead with team/business tiers. That is a legitimate position, but the UI must justify Adv with features (premium models, larger context, 500 messages), because on price alone the ADV card loses a direct comparison with the most famous tool in the category.

Free (BYOK) has no price competitor at all: an unlimited-in-cost free tier at ₹0 marginal cost is something metered free tiers cannot match.

---

## 9. Cost-reduction levers (ranked by value × confidence)

| # | Lever | Est. impact on token cost | Confidence | Status |
|---|---|---|---|---|
| 1 | **Enforce caps server-side** (meter + Supabase session check) | Protects the entire downside | High | ❌ Not built — **blocker** |
| 2 | **History trim** (sliding window + rolling summary instead of re-sending everything) | −25% to −35% | High | ❌ Not built |
| 3 | **Repo-map caching** (send the map once / use provider context caching) | −10% to −20% | Medium | ❌ Not built |
| 4 | **Diff-based file edits** instead of full-file rewrite (output is 40% of cost) | −25% to −33% | Medium | ❌ Not built |
| 5 | **Route heavy turns to the cheapest model** | −60% on those turns | High | ❌ Not built |
| 6 | Keep Gemini 3 Flash out of the default Adv mix | −15% on Adv | High | 🟡 Partly (premium is a minority) |

Combined potential of #2 + #3 + #4: roughly **−50% to −60% of total token cost** — at 5,000 Pro users that is on the order of **₹1.5 lakh/month**. None of it is required for ₹499 to work; all of it is upside.

---

## 10. Risk register

| Risk | Severity | Why | Mitigation |
|---|---|---|---|
| **Caps are not enforceable** | 🔴 Critical | The counter lives in `localStorage` and is checked in the client. Clearing site data, calling the API directly, or using the in-app "Reset quota (dev test)" button removes it. Anyone can extract unlimited paid-tier usage. | Ship the server-side meter (Supabase + `check_and_increment_quota`) **before** enabling the shared key in production. |
| **Free cap delivers friction without enforcement** | 🟠 High | ShadRox pays the conversion cost of a 100-message cap while getting none of the protection, because the cap is bypassable. | Enforce it, or drop it and make Free genuinely unlimited (cost is ₹0 either way). |
| Premium models leaked to Pro | 🟠 High | 250 heavy turns on 70B = ₹600 cost vs ₹411 revenue. | Keep the shared-key catalog gated by `classifyTier` (already enforced server-side). |
| **Adv value-per-rupee is worse than Pro** | 🟡 Medium | Adv net price per message (₹1.81) exceeds Pro's (₹1.64), so the ladder can read as a price increase. | Widen Adv's message allowance or make premium models an explicit, named Adv feature. |
| Token-profile assumption is wrong | 🟠 High | The entire model rests on an *estimated* per-turn profile, not measured data. | Instrument real traffic for one week; replace §1.3 with measured p50/p95. |
| Supabase cost appears with the meter | 🟡 Low | +₹2,225/mo fixed. | Break-even goes 6 → 12 users. Trivial. |
| Provider rate changes | 🟡 Low | 20% rate change ≈ 3 margin points. | Review quarterly; prices have room. |
| FX slide | 🟢 Very low | 12% slide ≈ 1.7 margin points. | Ignore. |
| Billing not wired | 🟡 Low | No checkout exists; plan state is `localStorage` only. | Wire checkout when the meter ships. |

---

## 11. What is actually true today (vs modelled)

Be explicit with anyone reviewing this — part of the model describes a *future* product:

| Component | Real today? |
|---|---|
| Free plan (BYOK) | ✅ Working |
| 100 / 250 / 500 message caps (counting + UI gating) | ✅ Working in the client |
| Caps enforced against the API | ❌ **No** — server checks nothing; no 429 path exists |
| Shared ShadRox key (BYOK-less) | ⚠️ Server-side routing exists; no usage control |
| Plan tiers, prices, upgrade UI | 🟡 **UI only** — no checkout, no database, plan stored in `localStorage` |
| Usage meter / `usage_logs` | ❌ Does not exist |
| Enterprise features (SSO, audit log, secrets vault) | ❌ Do not exist |
| GST invoice / Razorpay integration | ❌ Does not exist |

---

## 12. Open questions for review

1. Is the per-turn token profile (§1.3) realistic? What would you estimate for input/output given repo map + BM25 context + full history in, full-file rewrite out?
2. Is `cost-fix factor = 0.5` too optimistic for history trim + repo-map caching? Not every provider offers a caching discount.
3. Should caps be **token-based** rather than message-based, given a heavy turn costs 7x a light one?
4. Is 250 messages the right Pro allowance? It is only ~31 working messages per month at 8/day — some active users will hit it in week one.
5. Should the Free 100-message cap exist at all, given its marginal cost is ₹0 and it is currently unenforceable?
6. Is Pro→Adv at 2.2x price / 2.0x messages the right step, and how is Adv's higher ₹/message justified in the UI?
7. Is 2.36% the correct gateway rate for Razorpay domestic cards, and is 18% GST correctly treated as price-inclusive?
8. Is there any reason to price Pro below ₹499 given the market sits at ₹890–₹1,780?

---

## Appendix A — Formulas

```
cost_per_message(model, profile)
  = ((profile.input × model.input_rate) + (profile.output × model.output_rate))
    / 1_000_000 × FX

bill(price)                          # price is GST-inclusive
  gst       = price × 0.18 / 1.18
  gateway   = price × 0.0236
  net       = price − gst − gateway

pro_token_cost(msgs)  = min(msgs, 250) × cost_per_message(scout, normal)

adv_token_cost(msgs)  = min(msgs, 500) × [0.9 × cost(scout, normal) + 0.1 × cost(gflash, normal)]

project(pro, adv, ent, msgs)
  gmv        = pro × 499 + adv × 1,099 + ent × 24,999
  net_rev    = gmv − gst(gmv) − gateway(gmv)
  tokens     = pro × pro_token_cost + adv × adv_token_cost + ent × 4,000
  fixed      = 1,863                                   # 0 if gmv = 0
  profit     = net_rev − tokens − fixed
```

## Appendix B — Constants one-liner

```
USD_INR=89  GST=18%  GATEWAY=2.36%  FIXED=1863
FREE=0/100  PRO=499/250  ADV=1099/500  ENT=24999/5000  ENT_TOKEN_ASSUMED=4000
RATES: instant 0.05/0.08 · scout 0.11/0.34 · llama70b 0.59/0.79 · gflash 0.50/3.00
PROFILE: light 6k/1.5k · normal 14k/3k · heavy 35k/8k
```
