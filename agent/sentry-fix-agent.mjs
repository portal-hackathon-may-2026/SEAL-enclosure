#!/usr/bin/env node
/**
 * Reads a Sentry issue (via the Sentry MCP server), reasons about a fix using
 * an OpenRouter-hosted model, edits files in the repo, and emits a summary that
 * the calling workflow uses to open a draft PR.
 *
 * Inputs (env):
 *   OPENROUTER_API_KEY     required
 *   OPENROUTER_MODEL       optional, defaults to anthropic/claude-sonnet-4
 *   SENTRY_ACCESS_TOKEN    required, user auth token for the Sentry MCP server
 *   SENTRY_HOST            optional, defaults to sentry.io
 *   SENTRY_ORG_SLUG        required, organization slug
 *   SENTRY_ISSUE_ID        required, numeric issue id or short id
 *   SENTRY_ISSUE_TITLE     optional, used to seed the prompt
 *   SENTRY_ISSUE_URL       optional, link to the issue
 *   REPO_ROOT              optional, defaults to process.cwd()
 *   AGENT_OUTPUT_PATH      optional, defaults to ./agent-result.json
 *   AGENT_MAX_ITERATIONS   optional, defaults to 25
 */

import OpenAI from 'openai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import fs from 'node:fs/promises'
import path from 'node:path'

const REPO_ROOT = path.resolve(process.env.REPO_ROOT || process.cwd())
const OUTPUT_PATH = path.resolve(process.env.AGENT_OUTPUT_PATH || path.join(REPO_ROOT, 'agent-result.json'))
const MAX_ITERATIONS = Number(process.env.AGENT_MAX_ITERATIONS || 25)
const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}

function resolveInsideRepo(relativePath) {
  const resolved = path.resolve(REPO_ROOT, relativePath)
  if (!resolved.startsWith(REPO_ROOT + path.sep) && resolved !== REPO_ROOT) {
    throw new Error(`Path escapes repo root: ${relativePath}`)
  }
  return resolved
}

const localTools = {
  read_file: {
    description: 'Read a UTF-8 text file from the repository, relative to repo root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to repo root.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async ({ path: filePath }) => {
      const resolved = resolveInsideRepo(filePath)
      const content = await fs.readFile(resolved, 'utf8')
      // Cap response to keep prompt size sane.
      const MAX = 60_000
      if (content.length > MAX) {
        return content.slice(0, MAX) + `\n\n[truncated ${content.length - MAX} bytes]`
      }
      return content
    },
  },
  write_file: {
    description: 'Overwrite a file in the repository with the provided content. Creates parent directories as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    handler: async ({ path: filePath, content }) => {
      const resolved = resolveInsideRepo(filePath)
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, content, 'utf8')
      return `wrote ${content.length} bytes to ${filePath}`
    },
  },
  list_directory: {
    description: 'List entries in a directory relative to repo root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to repo root. Defaults to repo root.' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async ({ path: dirPath = '.' }) => {
      const resolved = resolveInsideRepo(dirPath)
      const entries = await fs.readdir(resolved, { withFileTypes: true })
      return entries
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n')
    },
  },
  finish: {
    description:
      'Call when you have made all required changes (or determined no code change is needed). The workflow will commit the staged changes and open a draft PR using the summary you provide.',
    parameters: {
      type: 'object',
      properties: {
        branch_name: {
          type: 'string',
          description: 'Short kebab-case branch name, e.g. "sentry-fix-12345-null-deref".',
        },
        pr_title: { type: 'string', description: 'Short imperative PR title.' },
        pr_body: {
          type: 'string',
          description:
            'PR body in markdown. Should explain the root cause, the fix, and reference the Sentry issue link.',
        },
        no_change_reason: {
          type: 'string',
          description:
            'If you decided no code change is appropriate, explain why. Leave empty when proposing a fix.',
        },
      },
      required: ['branch_name', 'pr_title', 'pr_body'],
      additionalProperties: false,
    },
    handler: async (args) => args,
  },
}

function mcpToolToOpenAI(tool, prefix) {
  return {
    type: 'function',
    function: {
      name: `${prefix}__${tool.name}`,
      description: tool.description || `Sentry MCP tool ${tool.name}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }
}

function localToolToOpenAI(name, def) {
  return {
    type: 'function',
    function: {
      name,
      description: def.description,
      parameters: def.parameters,
    },
  }
}

async function main() {
  const openrouterKey = requireEnv('OPENROUTER_API_KEY')
  const sentryToken = requireEnv('SENTRY_ACCESS_TOKEN')
  const sentryOrg = requireEnv('SENTRY_ORG_SLUG')
  const issueId = requireEnv('SENTRY_ISSUE_ID')
  const sentryHost = process.env.SENTRY_HOST || 'sentry.io'

  const issueTitle = process.env.SENTRY_ISSUE_TITLE || `Sentry issue ${issueId}`
  const issueUrl = process.env.SENTRY_ISSUE_URL || ''

  // Boot the Sentry MCP server as a child process and connect over stdio.
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@sentry/mcp-server@latest'],
    env: {
      ...process.env,
      SENTRY_ACCESS_TOKEN: sentryToken,
      SENTRY_HOST: sentryHost,
    },
  })

  const mcp = new Client({ name: 'seal-enclosure-sentry-agent', version: '0.1.0' }, { capabilities: {} })
  await mcp.connect(transport)

  const { tools: mcpTools } = await mcp.listTools()
  const sentryTools = mcpTools.map((t) => mcpToolToOpenAI(t, 'sentry'))
  const localOpenAITools = Object.entries(localTools).map(([name, def]) => localToolToOpenAI(name, def))
  const allTools = [...sentryTools, ...localOpenAITools]

  const openai = new OpenAI({
    apiKey: openrouterKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/Eden-4/SEAL-enclosure',
      'X-Title': 'SEAL-enclosure Sentry auto-fix agent',
    },
  })

  const systemPrompt = `You are an automated debugging agent. A Sentry issue has fired in the repository checked out at the current working directory. Your job:

1. Use the sentry__* tools to fetch full details of the issue (stack trace, breadcrumbs, recent events). The organization slug is "${sentryOrg}".
2. Use list_directory and read_file to map the relevant code paths in the repo.
3. Identify the smallest, safest change that addresses the root cause. Prefer narrow fixes over refactors.
4. Apply the fix with write_file. Do not modify unrelated files.
5. When done, call the "finish" tool with branch_name, pr_title, and pr_body. The pr_body must explain the root cause, the fix, and link the Sentry issue.

Constraints:
- Never modify files outside the repository working directory.
- Never touch .github/, package-lock.json, or node_modules.
- If the issue does not warrant a code change (e.g., it's a transient network error or a user-induced error), call finish with no_change_reason set and leave write_file untouched.
- Hard iteration cap: ${MAX_ITERATIONS} model turns. Use them efficiently.`

  const userPrompt = `Sentry issue to investigate:
- ID: ${issueId}
- Title: ${issueTitle}
- Org: ${sentryOrg}
- URL: ${issueUrl || '(not provided)'}

Start by querying Sentry for the full issue and a recent event. Then explore the repo.`

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  let finishResult = null
  let iterations = 0

  while (iterations < MAX_ITERATIONS) {
    iterations += 1
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools: allTools,
      tool_choice: 'auto',
    })

    const choice = response.choices[0]
    const msg = choice.message
    messages.push(msg)

    const toolCalls = msg.tool_calls || []
    if (!toolCalls.length) {
      // Model produced a final assistant message without calling finish. Nudge it.
      messages.push({
        role: 'user',
        content:
          'You did not call any tool. If you have completed your work, call the "finish" tool now with the required arguments.',
      })
      continue
    }

    for (const call of toolCalls) {
      const name = call.function.name
      let args = {}
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
      } catch (err) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Invalid JSON arguments: ${err.message}`,
        })
        continue
      }

      try {
        if (name === 'finish') {
          finishResult = await localTools.finish.handler(args)
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Recorded finish. The workflow will take over from here.',
          })
        } else if (localTools[name]) {
          const result = await localTools[name].handler(args)
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          })
        } else if (name.startsWith('sentry__')) {
          const mcpName = name.slice('sentry__'.length)
          const result = await mcp.callTool({ name: mcpName, arguments: args })
          const text = (result.content || [])
            .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
            .join('\n')
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: text || '(empty)',
          })
        } else {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `Unknown tool: ${name}`,
          })
        }
      } catch (err) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Tool error: ${err.message}`,
        })
      }
    }

    if (finishResult) {
      break
    }
  }

  await mcp.close().catch(() => {})

  if (!finishResult) {
    finishResult = {
      branch_name: `sentry-fix-${issueId}-incomplete`,
      pr_title: `[incomplete] Investigate Sentry issue ${issueId}`,
      pr_body: `The auto-fix agent hit its iteration cap (${MAX_ITERATIONS}) without calling finish. Manual review needed.\n\nSentry issue: ${issueUrl || issueId}`,
      no_change_reason: 'Iteration cap reached.',
    }
  }

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(finishResult, null, 2))
  // eslint-disable-next-line no-console
  console.log(`Agent finished after ${iterations} iterations. Result written to ${OUTPUT_PATH}.`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Agent failed:', err)
  process.exit(1)
})
