import { describe, it, expect } from 'vitest'
import { buildCta } from './inquiry-session'

describe('buildCta', () => {
  it('keeps a signup CTA when the URL is https', () => {
    expect(buildCta('signup', 'https://app.example/signup')).toEqual({
      type: 'signup',
      signupUrl: 'https://app.example/signup',
    })
  })

  it('falls back to meeting when a signup URL is missing', () => {
    expect(buildCta('signup', null)).toEqual({ type: 'meeting', schedulingUrl: null })
  })

  it('falls back to meeting (and strips the URL) when a signup URL is not https', () => {
    expect(buildCta('signup', 'http://app.example/signup')).toEqual({
      type: 'meeting',
      schedulingUrl: null,
    })
    expect(buildCta('signup', 'javascript:alert(1)')).toEqual({
      type: 'meeting',
      schedulingUrl: null,
    })
  })

  it('renders a meeting CTA, keeping an https scheduling URL and dropping a non-https one', () => {
    expect(buildCta('meeting', 'https://cal.example/x')).toEqual({
      type: 'meeting',
      schedulingUrl: 'https://cal.example/x',
    })
    expect(buildCta('meeting', 'data:text/html,x')).toEqual({
      type: 'meeting',
      schedulingUrl: null,
    })
  })

  it('treats a null CTA type as meeting notify-only', () => {
    expect(buildCta(null, 'https://cal.example/x')).toEqual({
      type: 'meeting',
      schedulingUrl: 'https://cal.example/x',
    })
  })
})
