export OPENCLAW_STATE_DIR=/var/lib/plow
export OPENCLAW_CONFIG_PATH=/var/lib/plow/openclaw.json
if [ -r /var/lib/plow/gateway-password ]; then
  export OPENCLAW_GATEWAY_PASSWORD="$(cat /var/lib/plow/gateway-password)"
fi
