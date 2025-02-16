import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LinearClient, LinearError } from '@linear/sdk';
import { z } from "zod";
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.LINEAR_API_KEY) {
  console.error('ERROR: LINEAR_API_KEY is not set in .env file');
  process.exit(1);
}

class RateLimiter {
  constructor() {
    this.requestsPerHour = 1000;
    this.requests = [];
    this.metrics = {
      totalRequests: 0,
      requestsInLastHour: 0,
      averageRequestTime: 0,
      queueLength: 0,
      lastRequestTime: Date.now()
    };
  }

  async checkLimit() {
    const now = Date.now();
    this.requests = this.requests.filter(time => now - time < 3600000);
    if (this.requests.length >= this.requestsPerHour) {
      throw new Error('Rate limit exceeded');
    }
    this.requests.push(now);
    
    // Update metrics
    this.metrics.totalRequests++;
    this.metrics.requestsInLastHour = this.requests.length;
    this.metrics.lastRequestTime = now;
  }

  getMetrics() {
    return {
      ...this.metrics,
      remainingRequests: this.requestsPerHour - this.metrics.requestsInLastHour
    };
  }
}

// Initialize Linear client with custom headers
const linearClient = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY,
  headers: {
    'User-Agent': 'Linear MCP Server/1.0.0'
  }
});

const rateLimiter = new RateLimiter();

const PRIORITY_LABELS = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];

// Issue mapping helper
const mapIssue = (issue) => ({
  id: issue.id,
  identifier: issue.identifier,
  title: issue.title,
  status: issue.state?.name,
  assignee: issue.assignee?.name,
  priority: PRIORITY_LABELS[issue.priority || 0],
  url: issue.url,
  createdAt: issue.createdAt,
  estimate: issue.estimate,
  labels: issue.labels?.nodes?.map(label => label.name) || [],
  description: issue.description
});

// Default prompt definition
const defaultPrompt = {
  name: "default",
  description: "Default prompt for Linear MCP Server",
  messages: [
    {
      role: "system",
      content: {
        type: "text",
        text: "You are a Linear assistant that helps manage issues and projects. For issue queries, use the search-issues tool directly with appropriate filters like 'assignee:@me' and 'priority:high'."
      }
    }
  ]
};

// Initialize MCP server
const server = new McpServer({
  name: "linear",
  version: "1.0.0",
  description: "Linear MCP Server for accessing Linear resources",
  capabilities: {
    prompts: {
      default: defaultPrompt
    },
    resources: {
      templates: true,
      read: true
    },
    tools: {
      "create-issue": {
        description: "Create a new Linear issue"
      },
      "search-issues": {
        description: "Search Linear issues"
      },
      "read-resource": {
        description: "Read a Linear resource"
      },
      "update-issue-status": {
        description: "Update the status of a Linear issue"
      }
    }
  }
});

// Error handling helper
const handleLinearError = (error) => {
  if (error instanceof LinearError) {
    return `Linear API Error: ${error.message}`;
  }
  return `Error: ${error.message}`;
};

// Tool to create an issue
server.tool(
  "create-issue",
  "Create a new Linear issue",
  {
    title: z.string().describe("Issue title"),
    teamId: z.string().describe("Team ID"),
    description: z.string().optional().describe("Issue description"),
    priority: z.number().min(0).max(4).optional().describe(`Issue priority (${PRIORITY_LABELS.map((label, index) => `${index}: ${label}`).join(', ')})`),
    stateId: z.string().optional().describe("State ID"),
    assigneeId: z.string().optional().describe("Assignee ID"),
    estimate: z.number().optional().describe("Issue estimate"),
    labelIds: z.array(z.string()).optional().describe("Label IDs")
  },
  async (input) => {
    try {
      const issue = await linearClient.issueCreate(input);
      
      if (!issue.success) {
        throw new Error("Failed to create issue");
      }

      return createResponse({
        success: true,
        issue: mapIssue(issue.issue)
      });
    } catch (error) {
      console.error("Error in create-issue:", error);
      return createResponse({ error: handleLinearError(error) });
    }
  }
);

// Tool to search issues
server.tool(
  "search-issues",
  "Search Linear issues",
  {
    query: z.string().describe("Search query"),
    teamId: z.string().optional().describe("Team ID to filter by"),
    status: z.string().optional().describe("Status to filter by"),
    assigneeId: z.string().optional().describe("Assignee ID to filter by")
  },
  async ({ query }) => {
    try {
      await rateLimiter.checkLimit();

      let me;
      try {
        me = await linearClient.viewer;
      } catch (error) {
        console.error("Failed to get viewer:", error);
        throw new Error("Failed to get current user information");
      }

      const { filter, isMyIssuesQuery, priorityFilter } = parseQuery(query);

      if (isMyIssuesQuery) {
        const myIssues = await me.assignedIssues({
          first: 100,
          orderBy: "updatedAt",
          filter
        });

        const mappedIssues = myIssues.nodes.map(mapIssue);

        console.error('Debug - Raw issue data:', JSON.stringify(myIssues.nodes[0], null, 2));
        console.error('Debug - Mapped issue:', JSON.stringify(mappedIssues[0], null, 2));

        return createResponse({
          message: `Found ${mappedIssues.length} issues assigned to you`,
          total: mappedIssues.length,
          issues: mappedIssues
        });
      }

      const { nodes } = await linearClient.issues({
        first: 100,
        filter: {
          ...filter,
          priority: priorityFilter
        },
        orderBy: "updatedAt",
        includeArchived: false
      });

      const mappedIssues = nodes.map(mapIssue);

      console.error('Debug - Raw issue data:', JSON.stringify(nodes[0], null, 2));
      console.error('Debug - Mapped issue:', JSON.stringify(mappedIssues[0], null, 2));

      return createResponse({
        message: `Found ${mappedIssues.length} issues`,
        total: mappedIssues.length,
        issues: mappedIssues
      });
    } catch (error) {
      console.error("Error in search-issues:", error);
      return createResponse({ error: handleLinearError(error) });
    }
  }
);

// Tool to read a resource
server.tool(
  "read-resource",
  "Read a Linear resource",
  {
    uri: z.string().describe("Resource URI to read e.g. linear://issues/4cb972e7-9ba1-4c52-8465-cdf2679ccea7")
  },
  async ({ uri }) => {
    try {
      let data;
      const matches = uri.match(/^linear:\/\/([^/]+)\/(.+)$/);
      if (!matches) {
        throw new Error(`Invalid Linear URI format: ${uri}`);
      }
      
      const [, resourceType, id] = matches;
      switch (resourceType) {
        case "issues": {
          if (id) {
            const issue = await linearClient.issue(id);
            if (!issue) {
              throw new Error(`Issue not found: ${id}`);
            }
            data = mapIssue(issue);
          } else {
            const { nodes } = await linearClient.issues({
              first: 100,
              orderBy: "updatedAt",
              includeArchived: false
            });
            data = nodes.map(mapIssue);
          }
          break;
        }
        case "organization": {
          const org = await linearClient.organization;
          data = {
            id: org.id,
            name: org.name,
            urlKey: org.urlKey,
            createdAt: org.createdAt
          };
          break;
        }
        case "teams": {
          if (id) {
            const team = await linearClient.team(id);
            const states = await team.states().then(states => 
              states.nodes.map(state => ({
                id: state.id,
                name: state.name,
                type: state.type
              }))
            );
            data = mapTeam(team, states);
          } else {
            const { nodes } = await linearClient.teams();
            data = await Promise.all(nodes.map(async team => {
              const states = await team.states().then(states => 
                states.nodes.map(state => ({
                  id: state.id,
                  name: state.name,
                  type: state.type
                }))
              );
              return mapTeam(team, states);
            }));
          }
          break;
        }
        default:
          throw new Error(`Unknown resource type: ${resourceType}`);
      }

      return createResponse({ data });
    } catch (error) {
      console.error("Error in read-resource:", error);
      return createResponse({ error: handleLinearError(error) });
    }
  }
);

// Tool to update issue status
server.tool(
  "update-issue-status",
  "Update the status of a Linear issue",
  {
    issueId: z.string().describe("ID of the issue to update"),
    state: z.union([
      z.string().describe("Name of the state (e.g. 'In Progress', 'Done')"),
    ]).describe("Either state name or state object with ID")
  },
  async ({ issueId, state }) => {
    try {
      await rateLimiter.checkLimit();

      const issue = await linearClient.issue(issueId);
      if (!issue) {
        throw new Error(`Issue not found: ${issueId}`);
      }

      let stateId;
      if (typeof state === 'string') {
        // If state is a name, we need to find its ID from the team's states
        const team = await linearClient.team((await issue.team)?.id);
        if (!team) {
          throw new Error(`Team not found for issue: ${issueId}`);
        }

        const states = await team.states();
        const matchingState = states.nodes.find(s => 
          s.name.toLowerCase() === state.toLowerCase()
        );

        if (!matchingState) {
          const availableStates = states.nodes.map(s => s.name).join(', ');
          throw new Error(`State "${state}" not found. Available states: ${availableStates}`);
        }

        stateId = matchingState.id;
      } else {
        // If state is an object with ID, use it directly
        stateId = state.id;
      }

      const updatedIssue = await issue.update({
        stateId: stateId
      });

      if (!updatedIssue) {
        throw new Error("Failed to update issue status");
      }

      return createResponse({
        success: true,
        message: "Issue status updated successfully",
        issue: mapIssue(updatedIssue)
      });
    } catch (error) {
      console.error("Error in update-issue-status:", error);
      return createResponse({ error: handleLinearError(error) });
    }
  }
);

// Start the server
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Linear MCP Server running on stdio");
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

const parseQuery = (query) => {
  const queryParts = query.match(/\S+:"[^"]+"|[^:\s]+:[^\s]+|\S+/g) || [];
  const filter = {
    state: {
      type: {
        nin: ["completed", "canceled"]
      }
    }
  };
  let isMyIssuesQuery = false;
  let priorityFilter;
  let hasExplicitStateFilter = false;

  for (const part of queryParts) {
    const [key, value] = part.split(':');
    const cleanValue = value?.replace(/^"(.*)"$/, '$1');
    const result = parseQueryPart(key, cleanValue, filter);
    isMyIssuesQuery = result.isMyIssuesQuery || isMyIssuesQuery;
    priorityFilter = result.priorityFilter || priorityFilter;
    hasExplicitStateFilter = result.hasExplicitStateFilter || hasExplicitStateFilter;
  }

  // Remove default status filter if status is explicitly specified
  if (hasExplicitStateFilter) {
    delete filter.state.type;
  }

  return { filter, isMyIssuesQuery, priorityFilter };
};

const parseQueryPart = (key, cleanValue, filter) => {
  let isMyIssuesQuery = false;
  let priorityFilter;
  let hasExplicitStateFilter = false;

  switch (key) {
    case 'assignee':
      if (cleanValue === '@me') {
        isMyIssuesQuery = true;
      }
      break;
    case 'priority':
      priorityFilter = parsePriorityFilter(cleanValue);
      break;
    case 'state':
    case 'status':
      hasExplicitStateFilter = true;
      filter.state = { name: { eq: cleanValue } };
      break;
    case 'team':
      filter.team = { name: { eq: cleanValue } };
      break;
    case 'label':
      filter.labels = { name: { eq: cleanValue } };
      break;
    default:
      if (!key.includes(':')) {
        filter.or = [
          { title: { contains: key } },
          { description: { contains: key } }
        ];
      }
  }

  return { isMyIssuesQuery, priorityFilter, hasExplicitStateFilter };
};

const parsePriorityFilter = (value) => {
  const PRIORITY_MAP = {
    'no': 0,
    'urgent': 1,
    'high': 2,
    'medium': 3,
    'low': 4
  };

  // If the value is a number
  if (!isNaN(value)) {
    const numValue = parseInt(value, 10);
    if (numValue >= 0 && numValue <= 4) {
      if (numValue === 2) {
        return { in: [1, 2] }; // Include both Urgent (1) and High (2)
      }
      return { eq: numValue };
    }
    return undefined;
  }

  // Otherwise, use the priority map
  const lowercaseValue = value.toLowerCase();
  if (lowercaseValue === 'high') {
    return { in: [1, 2] }; // Include both Urgent (1) and High (2)
  } else if (PRIORITY_MAP[lowercaseValue] !== undefined) {
    return { eq: PRIORITY_MAP[lowercaseValue] };
  }
  return undefined;
};

const mapTeam = (team, states) => ({
  id: team.id,
  name: team.name,
  key: team.key,
  description: team.description,
  states: states.map(mapState)
});

const mapState = (state) => ({
  id: state.id,
  name: state.name,
  type: state.type
});

const createResponse = (data) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        ...data,
        apiMetrics: rateLimiter.getMetrics()
      }, null, 2)
    }
  ]
});