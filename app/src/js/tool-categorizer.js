// Tool Categorization - maps tool names to user-friendly status labels

export function categorizeToolUse(toolName, input) {
  // Preview grep - looking closer at a script
  if (toolName === 'ropilot_sourcecontrol_previewgrep') {
    return {
      label: 'Looking closer at',
      detail: input.path || 'script'
    };
  }

  // Search tools - show what's being searched for
  if (toolName === 'ropilot_search' || toolName === 'ropilot_searchbyclass') {
    const query = input.query || input.className || '';
    return {
      label: 'Searching',
      detail: query ? `"${query}"` : 'game tree'
    };
  }

  // Exploration tools - show the path being explored
  if (toolName === 'ropilot_listchildren' || toolName === 'ropilot_getproperties') {
    const path = input.path || '';
    return {
      label: 'Exploring',
      detail: path || 'game tree'
    };
  }

  // Read tools
  if (toolName === 'ropilot_requestscript') {
    return {
      label: 'Reading',
      detail: input.path || 'script'
    };
  }

  // Commit script (save)
  if (toolName === 'ropilot_sourcecontrol_commitscript') {
    return {
      label: 'Saving',
      detail: input.path || 'script'
    };
  }

  // Write tools
  if (toolName === 'ropilot_commitscript') {
    return {
      label: 'Saving',
      detail: input.path || 'script'
    };
  }

  if (['ropilot_setproperties', 'ropilot_createscript'].includes(toolName)) {
    const path = input.path || input.target || '';
    return {
      label: 'Modifying',
      detail: path || 'instance'
    };
  }

  // Create/delete tools
  if (toolName === 'ropilot_create') {
    return {
      label: 'Creating',
      detail: `${input.className} in ${input.parent || '...'}`
    };
  }

  if (toolName === 'ropilot_delete') {
    return {
      label: 'Deleting',
      detail: input.path || 'instance'
    };
  }

  // Playtest tools
  if (toolName === 'ropilot_test_start_playtest') {
    return { label: 'Starting', detail: 'playtest' };
  }

  if (toolName === 'ropilot_test_stop_playtest') {
    return { label: 'Stopping', detail: 'playtest' };
  }

  if (toolName === 'ropilot_test_run_client_lua' || toolName === 'ropilot_test_run_server_lua') {
    return { label: 'Running', detail: 'Lua script' };
  }

  // Default
  return {
    label: 'Working',
    detail: toolName.replace('ropilot_', '')
  };
}
