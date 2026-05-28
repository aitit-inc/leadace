# Industry Vocabulary

Controlled list used when registering an organization with `add_prospects`.
Pick **the closest single category** for each prospect. Keep the wording
verbatim — `/evaluate` aggregates by exact-match on `industry`, so free-form
labels degrade the analytics.

If a prospect genuinely fits none of these (e.g. a niche scientific instrument
maker), fall back to `Other` rather than inventing a new label.

## Categories

### Software & Tech
- `B2B SaaS`
- `Consumer Software / Apps`
- `Marketplace / Platform`
- `DevTools / Developer Platform`
- `Data / Analytics`
- `AI / ML`
- `Cybersecurity`
- `Cloud Infrastructure / Hosting`

### Industry-Specific Tech
- `FinTech`
- `HealthTech / Biotech`
- `EdTech`
- `HR Tech / Recruiting Software`
- `Marketing / AdTech`
- `Sales / CRM Tech`
- `LegalTech`
- `PropTech / Real Estate Tech`
- `AgTech`
- `CleanTech / EnergyTech`
- `LogisticsTech / Supply Chain Tech`
- `MobilityTech`
- `RetailTech / E-commerce Tech`
- `ConstructionTech`
- `GovTech`

### Hardware & Industrial
- `Hardware / IoT / Robotics`
- `Manufacturing`
- `Construction`
- `Energy / Utilities`
- `Logistics / Transportation`
- `Agriculture`

### Commerce & Consumer
- `E-commerce / Retail`
- `Food / Beverage`
- `Fashion / Apparel`
- `Beauty / Wellness`
- `Media / Publishing`
- `Entertainment / Gaming`
- `Travel / Hospitality`
- `Sports / Fitness`

### Services
- `Financial Services` (banks, insurers, asset managers without a tech wrapper)
- `Healthcare Provider`
- `Education Institution` (schools, universities, after-school programs)
- `Professional Services / Consulting`
- `Legal Services`
- `Accounting / Tax`
- `Staffing / Recruiting Services`
- `Real Estate Services` (brokers, property management)
- `Marketing / Advertising Agency`
- `Construction / Contracting`

### Public & Nonprofit
- `Government / Public Sector`
- `Nonprofit`
- `Industry Association / Federation`

### Catch-all
- `Other`

## Picking rules

- A SaaS product targeting one industry takes the **industry-specific tech**
  label, not generic `B2B SaaS`. Example: a CRM for dentists is `HealthTech`,
  not `Sales / CRM Tech`.
- A consulting firm specialising in tech still uses
  `Professional Services / Consulting`, not the tech label.
- Schools, universities, and learning centres (the operators, not vendors
  of edtech products) use `Education Institution`.
- Agencies that mostly resell or implement someone else's software stay
  under `Marketing / Advertising Agency` or
  `Professional Services / Consulting`.
