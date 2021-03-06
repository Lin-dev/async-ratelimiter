/* eslint handle-callback-err: "off" */

'use strict'

const should = require('should')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const RateLimiter = require('..')
;['ioredis'].forEach(function (redisModuleName) {
  let redisModule = require(redisModuleName)
  let db = require(redisModuleName).createClient()

  describe('Limiter with ' + redisModuleName, function () {
    beforeEach(async function () {
      const keys = await db.keys('limit:*')
      await Promise.all(keys.map(key => db.del(key)))
    })

    describe('.total', function () {
      it('should represent the total limit per reset period', async function () {
        let limit = new RateLimiter({
          max: 5,
          id: 'something',
          db: db
        })
        const res = await limit.get()
        should(res.total).equal(5)
      })
    })

    describe('.remaining', function () {
      it('should represent the number of requests remaining in the reset period', async function () {
        let limit = new RateLimiter({
          max: 5,
          duration: 100000,
          id: 'something',
          db: db
        })

        let res
        res = await limit.get()
        should(res.remaining).equal(5)
        res = await limit.get()
        should(res.remaining).equal(4)
        res = await limit.get()
        should(res.remaining).equal(3)
      })
    })

    describe('.reset', function () {
      it('should represent the next reset time in UTC epoch seconds', async function () {
        let limit = new RateLimiter({
          max: 5,
          duration: 60000,
          id: 'something',
          db: db
        })
        const res = await limit.get()
        let left = res.reset - Date.now() / 1000
        should(left)
          .be.below(60)
          .and.be.greaterThan(0)
      })
    })

    describe('when the limit is exceeded', function () {
      it('should retain .remaining at 0', async function () {
        let limit = new RateLimiter({
          max: 2,
          id: 'something',
          db: db
        })

        let res
        res = await limit.get()
        should(res.remaining).equal(2)
        res = await limit.get()
        should(res.remaining).equal(1)
        res = await limit.get()
        should(res.remaining).equal(0)
      })
    })

    describe('when the duration is exceeded', function () {
      it('should reset', async function () {
        this.timeout(5000)
        let limit = new RateLimiter({
          duration: 2000,
          max: 2,
          id: 'something',
          db: db
        })

        let res
        res = await limit.get()
        should(res.remaining).equal(2)
        res = await limit.get()
        should(res.remaining).equal(1)

        await delay(3000)
        res = await limit.get()
        let left = res.reset - Date.now() / 1000
        should(left).be.below(2)
        should(res.remaining).equal(2)
      })
    })

    describe('when multiple successive calls are made', function () {
      it('the next calls should not create again the limiter in Redis', async function () {
        let limit = new RateLimiter({
          duration: 10000,
          max: 2,
          id: 'something',
          db: db
        })

        let res
        res = await limit.get()
        should(res.remaining).equal(2)
        res = await limit.get()
        should(res.remaining).equal(1)
      })
      it('updating the count should keep all TTLs in sync', async function () {
        let limit = new RateLimiter({
          duration: 10000,
          max: 2,
          id: 'something',
          db: db
        })
        await limit.get() // All good here.
        await limit.get()

        const res = await db
          .multi()
          .pttl(['limit:something:count'])
          .pttl(['limit:something:limit'])
          .pttl(['limit:something:reset'])
          .exec()

        let ttlCount = typeof res[0] === 'number' ? res[0] : res[0][1]
        let ttlLimit = typeof res[1] === 'number' ? res[1] : res[1][1]
        let ttlReset = typeof res[2] === 'number' ? res[2] : res[2][1]
        ttlLimit.should.equal(ttlCount)
        ttlReset.should.equal(ttlCount)
      })
    })

    describe('when trying to decrease before setting value', function () {
      it('should create with ttl when trying to decrease', async function () {
        let limit = new RateLimiter({
          duration: 10000,
          max: 2,
          id: 'something',
          db: db
        })

        db.setex('limit:something:count', -1, 1, async function () {
          let res
          res = await limit.get()
          should(res.remaining).equal(2)
          res = await limit.get()
          should(res.remaining).equal(1)
          res = await limit.get()
          should(res.remaining).equal(0)
        })
      })
    })

    describe('when multiple concurrent clients modify the limit', function () {
      let clientsCount = 7
      let max = 5
      let left = max
      let limits = []

      for (let i = 0; i < clientsCount; ++i) {
        limits.push(
          new RateLimiter({
            duration: 10000,
            max: max,
            id: 'something',
            db: redisModule.createClient()
          })
        )
      }

      it('should prevent race condition and properly set the expected value', async function () {
        let responses = []

        function complete () {
          responses.push(arguments)

          if (responses.length === clientsCount) {
            // If there were any errors, report.
            let err = responses.some(function (res) {
              return res[0]
            })

            if (err) {
              throw err
            } else {
              responses.sort(function (r1, r2) {
                return r1[1].remaining < r2[1].remaining
              })
              responses.forEach(function (res) {
                should(res[1].remaining).equal(left < 0 ? 0 : left)
                left--
              })

              for (let i = max - 1; i < clientsCount; ++i) {
                should(responses[i][1].remaining).equal(0)
              }
            }
          }
        }

        // Warm up and prepare the data.
        let res = await limits[0].get()
        should(res.remaining).equal(left--)

        // Simulate multiple concurrent requests.
        limits.forEach(function (limit) {
          limit.get(complete)
        })
      })
    })

    describe('when limiter is called in parallel by multiple clients', function () {
      let max = 6
      let limiter

      limiter = new RateLimiter({
        duration: 10000,
        max: max,
        id: 'asyncsomething',
        db: redisModule.createClient()
      })

      it('should set the count properly without race conditions', async function () {
        const times = Array.from({ length: max }, (value, index) => index)
        const limits = await Promise.all(times.map(() => limiter.get()))
        limits.forEach(function (limit) {
          should(limit.remaining).equal(max--)
        })
      })
    })
  })
})
