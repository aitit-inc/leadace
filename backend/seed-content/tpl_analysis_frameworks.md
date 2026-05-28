# Analysis & Improvement Frameworks

A reference guide for improving analysis accuracy in /evaluate.

## Root Cause Analysis for Low Response Rates (6 Perspectives)

When response rates fall below expectations, examine the following 6 causes in order:

### 1. Subject Line Problem (Not Being Opened)
- Symptoms: Overall low engagement
- Remedies: Shorten the subject line, add numbers, include the recipient's company name, spark curiosity

### 2. Targeting Problem (Wrong Audience)
- Symptoms: Zero responses despite high volume
- Remedies: Revisit target definition, analyze common traits among companies that did respond

### 3. Body Content Problem (Read but No Action)
- Symptoms: Some responses come in but positive rate is low
- Remedies: Lead with recipient benefits, reduce self-promotion, add specific numbers/case studies

### 4. CTA Problem (Response Barrier Too High)
- Symptoms: Interest seems present but no replies
- Remedies: "30-minute meeting" → "15-minute information exchange", "Shall I send you materials?"

### 5. Timing Problem (Poor Send Time)
- Symptoms: Response rate skewed by day of week or time of day
- Remedies: Since sending timing is determined by the daily-cycle execution schedule (cron, etc.), do NOT write sending time constraints in SALES_STRATEGY.md. Instead, report in the report or "notes for next time" as a **recommendation** such as "Tue-Thu mornings tend to show higher response rates." Users adjust execution timing by modifying cron settings

### 6. Channel Problem (Other Channels More Effective)
- Symptoms: No response from email but responses from SNS (or vice versa)
- Remedies: Change channel priority order

## A/B Test Design

When there is an improvement hypothesis, design A/B tests with the following elements:

### Test Elements
- **Subject line patterns**: Curiosity-type vs. number-type vs. problem-mention-type
- **Email length**: Short (150 characters) vs. detailed (300 characters)
- **CTA phrasing**: "Meeting" vs. "information exchange" vs. "demo" vs. "send materials"
- **Tone**: Formal vs. casual
- **Hook**: Company name mention vs. industry challenge vs. numbers/achievements

### Test Conditions
- Change only one element per test
- Send at least 15 of each pattern (for statistical significance)
- Distribute evenly among prospects with the same attributes
- Define measurement metrics in advance (response rate, positive response rate, etc.)

### Recording in the evaluations Table
Record test results in the improvements JSON in the following format:
```json
{
  "type": "ab_test",
  "element": "subject_line",
  "pattern_a": "Number type: Track record of XX% improvement",
  "pattern_b": "Problem type: Struggling with {problem}?",
  "result": "pattern_a had 2.1% higher response rate",
  "applied": "Adopted pattern_a as default"
}
```

## Targeting Accuracy Verification

Once send data has accumulated, perform the following analyses:

### Analysis of Common Traits Among Responding Companies
- Industry, size, region, search keywords, priority score
- Traits common to responding companies but absent in non-responding companies

### Analysis of Common Traits Among Non-Responding Companies
- Traits common to companies with no response
- Identify segments to exclude

### Actions
- Update target definition in SALES_STRATEGY.md
- Add/remove search keywords
- Adjust priority scores (bulk update via `record_evaluation` MCP tool with `priorityUpdates`)
