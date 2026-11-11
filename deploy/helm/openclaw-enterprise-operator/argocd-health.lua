hs = { status = "Progressing", message = "Waiting for Enterprise observation" }
if obj.status == nil or obj.status.observedGeneration ~= obj.metadata.generation then
  return hs
end
-- Enable this trusted customization's standard Lua libraries and keep Argo in UTC.
local year, month, day, hour, minute, second = string.match(obj.status.lastObservedTime or "", "^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)")
if year == nil then
  hs.message = "Enterprise observation has no timestamp"
  return hs
end
local observed = os.time({ year = tonumber(year), month = tonumber(month), day = tonumber(day), hour = tonumber(hour), min = tonumber(minute), sec = tonumber(second), isdst = false })
local age = os.difftime(os.time(), observed)
if age > 90 or age < -30 then
  hs.message = "Enterprise observation is stale"
  return hs
end
for _, condition in ipairs(obj.status.conditions or {}) do
  if condition.type == "Ready" and condition.observedGeneration == obj.metadata.generation then
    hs.message = condition.message or hs.message
    if condition.reason == "ManagementSuspended" then
      hs.status = "Suspended"
    elseif condition.status == "True" then
      hs.status = "Healthy"
    elseif condition.status == "False" or condition.reason == "DeploymentFailed" or condition.reason == "OwnershipConflict" then
      hs.status = "Degraded"
    end
  end
end
return hs
