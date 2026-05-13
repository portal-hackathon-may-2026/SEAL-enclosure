const express = require('express')
const crypto = require('crypto')

const router = express.Router()

const SENTRY_SIGNATURE_HEADER = 'sentry-hook-signature'
const SENTRY_RESOURCE_HEADER = 'sentry-hook-resource'

function verifySignature(rawBody, secret, providedSignature) {
  if (!secret || !providedSignature) {
    return false
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  let providedBuffer
  try {
    providedBuffer = Buffer.from(providedSignature, 'hex')
  } catch {
    return false
  }
  if (expectedBuffer.length !== providedBuffer.length) {
    return false
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer)
}

function extractIssue(payload) {
  const data = payload && payload.data
  if (!data) return null

  // Sentry sends different shapes for "issue", "event_alert", and "error" resources.
  const issue = data.issue || (data.event && data.event.issue) || null
  const event = data.event || null

  if (!issue && !event) return null

  return {
    issueId: issue ? String(issue.id) : event && event.issue_id ? String(event.issue_id) : null,
    shortId: issue ? issue.short_id : null,
    title: (issue && issue.title) || (event && event.title) || 'Sentry issue',
    culprit: (issue && issue.culprit) || (event && event.culprit) || null,
    projectSlug:
      (issue && issue.project && issue.project.slug) ||
      (data.project && data.project.slug) ||
      null,
    organizationSlug: payload.installation && payload.installation.organization
      ? payload.installation.organization.slug
      : null,
    permalink: (issue && issue.permalink) || (event && event.web_url) || null,
    level: (issue && issue.level) || (event && event.level) || null,
  }
}

async function triggerRepositoryDispatch(issue, payload) {
  const token = process.env.GITHUB_DISPATCH_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  if (!token || !repo) {
    throw new Error('GITHUB_DISPATCH_TOKEN and GITHUB_REPOSITORY must be set to trigger workflows.')
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'seal-enclosure-sentry-webhook',
    },
    body: JSON.stringify({
      event_type: 'sentry-issue',
      client_payload: { issue, sentry: payload },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub dispatch failed (${response.status}): ${body}`)
  }
}

router.post(
  '/api/sentry/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res, next) => {
    try {
      const secret = process.env.SENTRY_WEBHOOK_SECRET
      const signature = req.header(SENTRY_SIGNATURE_HEADER)

      if (!verifySignature(req.body, secret, signature)) {
        return res.status(401).json({ error: 'Invalid signature' })
      }

      let payload
      try {
        payload = JSON.parse(req.body.toString('utf8'))
      } catch {
        return res.status(400).json({ error: 'Invalid JSON' })
      }

      const resource = req.header(SENTRY_RESOURCE_HEADER)
      const action = payload && payload.action

      // Only react to new/unresolved issues. Skip resolution, assignment, etc.
      const interestingActions = new Set(['created', 'triggered'])
      if (action && !interestingActions.has(action)) {
        return res.status(202).json({ skipped: true, reason: `action=${action}` })
      }

      const issue = extractIssue(payload)
      if (!issue || !issue.issueId) {
        return res.status(202).json({ skipped: true, reason: 'no issue id in payload' })
      }

      await triggerRepositoryDispatch(issue, { resource, action })

      return res.status(202).json({ dispatched: true, issueId: issue.issueId })
    } catch (err) {
      return next(err)
    }
  }
)

module.exports = router
