# Security

Contact: [leo.uno@surpassone.com](mailto:leo.uno@surpassone.com)
Preferred channel: [Report a vulnerability](https://github.com/aitit-inc/leadace/security/advisories/new)
(GitHub private security advisory)

At LeadAce, we consider the security of our systems a top priority. But
no matter how much effort we put into system security, there can still
be vulnerabilities present.

If you discover a vulnerability, we would like to know about it so we
can take steps to address it as quickly as possible. We would like to
ask you to help us better protect our customers and our systems.

## Out of scope vulnerabilities

- Clickjacking on pages with no sensitive actions.
- Unauthenticated/logout/login CSRF.
- Attacks requiring MITM or physical access to a user's device.
- Attacks requiring social engineering.
- Any activity that could lead to the disruption of our service (DoS).
- Content spoofing and text injection issues without showing an attack
  vector / without being able to modify HTML/CSS.
- Email spoofing.
- Missing DNSSEC, CAA, CSP headers.
- Lack of `Secure` or `HttpOnly` flags on non-sensitive cookies.
- Dead links.
- User enumeration.
- Findings on a self-hosted deployment that depend on the operator
  misconfiguring their own infrastructure (weak
  `GMAIL_TOKEN_ENCRYPTION_KEY`, leaked Supabase service-role key, etc.)
  without an underlying defect in the LeadAce code.

Issues in third-party services we depend on (Cloudflare, Supabase,
Stripe, Resend, Google) should be reported upstream to those vendors.

## Please do the following

- Report your findings via the
  [GitHub private security advisory](https://github.com/aitit-inc/leadace/security/advisories/new)
  flow, or by email to [leo.uno@surpassone.com](mailto:leo.uno@surpassone.com).
- Do not run automated scanners on our hosted service
  (`app.leadace.ai`, `api.leadace.ai`, `mcp.leadace.ai`,
  `leadace.ai`). Aggressive scanning can disrupt service for other
  users and trigger Cloudflare's WAF, and our own monitoring cannot
  distinguish hostile reconnaissance from research. If you want to run
  a scanner, contact us first and only run it against a self-hosted
  install you control.
- Do not take advantage of the vulnerability you have discovered — for
  example, by downloading more data than necessary to demonstrate it,
  or modifying / deleting other people's data.
- Do not reveal the problem to others until it has been resolved.
- Do not use attacks on physical security, social engineering,
  distributed denial of service, spam, or applications of third
  parties.
- Provide sufficient information to reproduce the problem so we can
  resolve it as quickly as possible. The affected URL, request
  payload, and a description of the vulnerability are usually enough;
  complex issues may need more.

## Tenant isolation

LeadAce uses Postgres Row-Level Security as a defense-in-depth layer
behind the application-level tenant filter. Reports involving
cross-tenant data exposure are treated as critical-severity regardless
of which layer the breach is found in. Please flag them clearly when
reporting.

## What we promise

- We will respond to your report within 5 business days with our
  evaluation and an expected resolution date.
- If you have followed the instructions above, we will not take any
  legal action against you in regard to the report.
- We will handle your report with strict confidentiality, and not pass
  on your personal details to third parties without your permission.
- We will keep you informed of the progress towards resolving the
  problem.
- In the public information concerning the problem reported, we will
  give your name as the discoverer of the problem (unless you ask us
  not to).
- We strive to resolve all problems as quickly as possible, and we
  would like to play an active role in the ultimate publication on the
  problem after it is resolved.
