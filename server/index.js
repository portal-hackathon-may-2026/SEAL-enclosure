require('dotenv').config()
const path = require('path')
const express = require('express')

const initializeSentry = require('./config/sentry')
const statusRoute = require('./routes/status')
const panelsRoute = require('./routes/panels')
const telemetryRoute = require('./routes/telemetry')
const debugRoute = require('./routes/debug')
const sentryWebhookRoute = require('./routes/sentryWebhook')
const errorHandler = require('./middleware/errorHandler')
const notFoundHandler = require('./middleware/notFound')

const app = express()
const port = Number(process.env.PORT || 3000)

initializeSentry()

// Webhook must be mounted before express.json so the raw body is preserved for signature verification.
app.use(sentryWebhookRoute)

app.use(express.json())

app.use(statusRoute)
app.use(panelsRoute)
app.use(telemetryRoute)
app.use(debugRoute)

const clientDist = path.join(__dirname, '..', 'client', 'dist')
app.use(express.static(clientDist))

app.use(notFoundHandler)
app.use(errorHandler)

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${port}`)
})
