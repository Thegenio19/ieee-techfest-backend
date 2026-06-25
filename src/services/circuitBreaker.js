'use strict';

/**
 * Hand-written 3-state Circuit Breaker.
 * Prevents cascading failures when third-party APIs (Razorpay) go down.
 */
class CircuitBreaker {
  constructor({ failureThreshold = 3, recoveryTimeout = 30000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout; // ms to wait before testing again
    
    this.state = 'CLOSED'; // 'CLOSED' (healthy), 'OPEN' (failing), 'HALF_OPEN' (testing)
    this.failureCount = 0;
    this.lastFailureTime = null;
  }

  async fire(asyncFn) {
    if (this.state === 'OPEN') {
      const now = Date.now();
      // If recovery timeout has passed, we test the system
      if (now - this.lastFailureTime > this.recoveryTimeout) {
        this.state = 'HALF_OPEN';
      } else {
        // Fast failure - don't even try hitting the API
        throw new Error('Circuit breaker is OPEN — Razorpay unavailable, try again shortly');
      }
    }

    try {
      const result = await asyncFn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.lastFailureTime = Date.now();
    }
  }
}

// Export as a singleton so the entire application shares the same state
const razorpayBreaker = new CircuitBreaker();
module.exports = razorpayBreaker;