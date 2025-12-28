/**
 * SYNAPSE Protocol - Load Testing Suite
 * 
 * k6 load testing scripts for protocol performance testing
 * 
 * Usage:
 *   k6 run --vus 50 --duration 5m loadtest.js
 *   k6 run --config config.json loadtest.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { randomIntBetween, randomItem } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// Custom metrics
const paymentSuccess = new Rate('payment_success_rate');
const paymentDuration = new Trend('payment_duration');
const agentQueries = new Counter('agent_queries');
const serviceQueries = new Counter('service_queries');
const wsConnections = new Gauge('websocket_connections');
const errorRate = new Rate('error_rate');

// Test configuration
export const options = {
  scenarios: {
    // Smoke test
    smoke: {
      executor: 'constant-vus',
      vus: 5,
      duration: '1m',
      tags: { test_type: 'smoke' },
      exec: 'smokeTest',
    },
    
    // Load test
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },   // Ramp up
        { duration: '5m', target: 50 },   // Stay at 50
        { duration: '2m', target: 100 },  // Ramp up more
        { duration: '5m', target: 100 },  // Stay at 100
        { duration: '2m', target: 0 },    // Ramp down
      ],
      tags: { test_type: 'load' },
      exec: 'loadTest',
      startTime: '1m', // Start after smoke test
    },
    
    // Stress test
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 100 },
        { duration: '5m', target: 200 },
        { duration: '5m', target: 300 },
        { duration: '5m', target: 400 },
        { duration: '2m', target: 0 },
      ],
      tags: { test_type: 'stress' },
      exec: 'stressTest',
      startTime: '17m', // Start after load test
    },
    
    // Spike test
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 500 },
        { duration: '1m', target: 500 },
        { duration: '10s', target: 0 },
      ],
      tags: { test_type: 'spike' },
      exec: 'spikeTest',
      startTime: '36m', // Start after stress test
    },
    
    // Soak test (long running)
    soak: {
      executor: 'constant-vus',
      vus: 50,
      duration: '30m',
      tags: { test_type: 'soak' },
      exec: 'soakTest',
      startTime: '38m', // Start after spike test
    },
  },
  
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
    payment_success_rate: ['rate>0.99'],
    payment_duration: ['p(95)<2000'],
    error_rate: ['rate<0.05'],
  },
};

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const GRAPHQL_URL = __ENV.GRAPHQL_URL || 'http://localhost:4000/graphql';
const WS_URL = __ENV.WS_URL || 'ws://localhost:8080';

// Test data
const testAddresses = new SharedArray('addresses', function () {
  return Array.from({ length: 100 }, (_, i) => 
    `0x${(i + 1).toString(16).padStart(40, '0')}`
  );
});

const testCategories = [
  'language_model',
  'image_generation',
  'code_generation',
  'translation',
  'data_analysis',
];

// Helper functions
function makePayment(from, to, amount) {
  const payload = JSON.stringify({
    from,
    to,
    amount: amount.toString(),
    paymentId: `pay-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  });
  
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': __ENV.API_KEY || 'test-key',
    },
  };
  
  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/payments`, payload, params);
  const duration = Date.now() - start;
  
  paymentDuration.add(duration);
  paymentSuccess.add(res.status === 200 || res.status === 201);
  
  return res;
}

function queryAgent(address) {
  const query = `
    query GetAgent($address: String!) {
      agent(address: $address) {
        address
        name
        tier
        reputationScore
        totalTransactions
      }
    }
  `;
  
  const res = http.post(GRAPHQL_URL, JSON.stringify({
    query,
    variables: { address },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  agentQueries.add(1);
  return res;
}

function queryServices(category) {
  const query = `
    query GetServices($category: String!) {
      services(category: $category, first: 10) {
        id
        name
        provider { address }
        basePrice
        active
      }
    }
  `;
  
  const res = http.post(GRAPHQL_URL, JSON.stringify({
    query,
    variables: { category },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  serviceQueries.add(1);
  return res;
}

function getProtocolStats() {
  const query = `
    query {
      protocolStats {
        totalPayments
        totalPaymentVolume
        activeAgents
        activeServices
      }
    }
  `;
  
  return http.post(GRAPHQL_URL, JSON.stringify({ query }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Smoke Test
export function smokeTest() {
  group('Smoke Test - Basic Functionality', () => {
    // Health check
    group('Health Check', () => {
      const res = http.get(`${BASE_URL}/health`);
      check(res, {
        'health check status is 200': (r) => r.status === 200,
        'health check returns healthy': (r) => {
          try {
            return JSON.parse(r.body).status === 'healthy';
          } catch {
            return false;
          }
        },
      });
    });
    
    // Protocol stats
    group('Protocol Stats', () => {
      const res = getProtocolStats();
      check(res, {
        'stats query succeeds': (r) => r.status === 200,
        'stats data present': (r) => {
          try {
            const data = JSON.parse(r.body);
            return data.data && data.data.protocolStats;
          } catch {
            return false;
          }
        },
      });
    });
    
    // Single payment
    group('Single Payment', () => {
      const from = randomItem(testAddresses);
      const to = randomItem(testAddresses);
      const amount = randomIntBetween(1, 100);
      
      const res = makePayment(from, to, amount);
      check(res, {
        'payment accepted': (r) => r.status === 200 || r.status === 201 || r.status === 402,
      });
    });
    
    sleep(1);
  });
}

// Load Test
export function loadTest() {
  group('Load Test - Normal Operations', () => {
    const action = randomIntBetween(1, 100);
    
    if (action <= 40) {
      // 40% - Query agents
      group('Query Agent', () => {
        const address = randomItem(testAddresses);
        const res = queryAgent(address);
        
        check(res, {
          'agent query succeeds': (r) => r.status === 200,
        });
        
        errorRate.add(res.status !== 200);
      });
    } else if (action <= 70) {
      // 30% - Query services
      group('Query Services', () => {
        const category = randomItem(testCategories);
        const res = queryServices(category);
        
        check(res, {
          'services query succeeds': (r) => r.status === 200,
        });
        
        errorRate.add(res.status !== 200);
      });
    } else if (action <= 90) {
      // 20% - Make payments
      group('Make Payment', () => {
        const from = randomItem(testAddresses);
        const to = randomItem(testAddresses);
        const amount = randomIntBetween(1, 1000);
        
        const res = makePayment(from, to, amount);
        
        check(res, {
          'payment request processed': (r) => r.status === 200 || r.status === 201 || r.status === 402,
        });
        
        errorRate.add(res.status >= 500);
      });
    } else {
      // 10% - Protocol stats
      group('Protocol Stats', () => {
        const res = getProtocolStats();
        
        check(res, {
          'stats query succeeds': (r) => r.status === 200,
        });
        
        errorRate.add(res.status !== 200);
      });
    }
    
    sleep(randomIntBetween(1, 3));
  });
}

// Stress Test
export function stressTest() {
  group('Stress Test - High Load', () => {
    // Rapid fire queries
    for (let i = 0; i < 5; i++) {
      const address = randomItem(testAddresses);
      queryAgent(address);
    }
    
    // Concurrent payments
    const from = randomItem(testAddresses);
    const to = randomItem(testAddresses);
    makePayment(from, to, randomIntBetween(1, 100));
    
    // Service queries
    queryServices(randomItem(testCategories));
    
    sleep(0.5);
  });
}

// Spike Test
export function spikeTest() {
  group('Spike Test - Sudden Traffic', () => {
    // Burst of requests
    for (let i = 0; i < 10; i++) {
      http.get(`${BASE_URL}/health`);
      queryAgent(randomItem(testAddresses));
      queryServices(randomItem(testCategories));
    }
    
    sleep(0.1);
  });
}

// Soak Test
export function soakTest() {
  group('Soak Test - Sustained Load', () => {
    // Mix of operations
    const action = randomIntBetween(1, 4);
    
    switch (action) {
      case 1:
        queryAgent(randomItem(testAddresses));
        break;
      case 2:
        queryServices(randomItem(testCategories));
        break;
      case 3:
        makePayment(
          randomItem(testAddresses),
          randomItem(testAddresses),
          randomIntBetween(1, 100)
        );
        break;
      case 4:
        getProtocolStats();
        break;
    }
    
    sleep(randomIntBetween(2, 5));
  });
}

// Setup function
export function setup() {
  console.log('Setting up load test...');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`GraphQL URL: ${GRAPHQL_URL}`);
  
  // Verify services are up
  const healthRes = http.get(`${BASE_URL}/health`);
  if (healthRes.status !== 200) {
    console.error('API health check failed!');
  }
  
  return {
    startTime: Date.now(),
  };
}

// Teardown function
export function teardown(data) {
  console.log(`Load test completed in ${(Date.now() - data.startTime) / 1000}s`);
}

// Default function (for simple runs)
export default function () {
  loadTest();
}
