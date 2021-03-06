const { balance, expectEvent, expectRevert } = require('@openzeppelin/test-helpers')
const isValidSignature = require('is-valid-signature')

const utils = require('../utils/utils')
const constants = require('../utils/constants.js')
const timeUtils = require('../utils/time.js')

const ArtifactBadTransaction = artifacts.require('BadTransaction')
const ArtifactAuthereumAccount = artifacts.require('AuthereumAccount')
const ArtifactAuthereumProxy = artifacts.require('AuthereumProxy')
const ArtifactAuthereumProxyFactory = artifacts.require('AuthereumProxyFactory')
const ArtifactAuthereumProxyAccountUpgrade = artifacts.require('UpgradeAccount')
const ArtifactAuthereumProxyAccountUpgradeWithInit = artifacts.require('UpgradeAccountWithInit')

contract('BaseAccount', function (accounts) {
  const OWNER = accounts[0]
  const RELAYER = accounts[9]
  const AUTH_KEYS = [accounts[1], accounts[2], accounts[3], accounts[4], accounts[5], accounts[6]]
  const RECEIVERS = [accounts[7]]
  const ENS_OWNER = accounts[8]
  const AUTHEREUM_OWNER = accounts[9]
  const LOGIN_KEYS = [accounts[10]]

  // Test Params
  let snapshotId

  // Params
  let badContract

  let MSG_SIG
  let label
  let expectedSalt
  let expectedCreationCodeHash
  let nonce
  let destination
  let value
  let gasLimit
  let data
  let gasPrice
  let gasOverhead
  let loginKeyRestrictionsData
  let feeTokenAddress
  let feeTokenRate
  let transactionMessageHashSignature
  let encodedParameters
  let transactions
  let loginKeyAttestationSignature

  // Addresses
  let expectedAddress
  let expectedAddressWithUpgrade
  let expectedAddressWithUpgradeWithInit

  // Logic Addresses
  let authereumProxyFactoryLogicContract
  let authereumAccountLogicContract
  let authereumProxyAccountUpgradeLogicContract
  let authereumProxyAccountUpgradeWithInitLogicContract

  // Contract Instances
  let authereumProxy
  let authereumProxyAccount
  let authereumProxyAccountUpgrade
  let authereumProxyAccountUpgradeWithInitt

  before(async () => {
    // Deploy Bad Contract
    badContract = await ArtifactBadTransaction.new()

    // Set up ENS defaults
    const { authereumEnsManager } = await utils.setENSDefaults(AUTHEREUM_OWNER)

    // Message signature
    MSG_SIG = await utils.getexecuteMultipleAuthKeyMetaTransactionsSig('2020021700')

    // Create Logic Contracts
    authereumAccountLogicContract = await ArtifactAuthereumAccount.new()
    authereumProxyFactoryLogicContract = await ArtifactAuthereumProxyFactory.new(authereumAccountLogicContract.address, authereumEnsManager.address)
    authereumProxyAccountUpgradeLogicContract = await ArtifactAuthereumProxyAccountUpgrade.new()
    authereumProxyAccountUpgradeWithInitLogicContract = await ArtifactAuthereumProxyAccountUpgradeWithInit.new()

    // Set up Authereum ENS Manager defaults
    await utils.setAuthereumENSManagerDefaults(authereumEnsManager, AUTHEREUM_OWNER, authereumProxyFactoryLogicContract.address, constants.AUTHEREUM_PROXY_RUNTIME_CODE_HASH)

    // Create default proxies
    label = constants.DEFAULT_LABEL
    expectedSalt = constants.SALT
    expectedCreationCodeHash = constants.AUTHEREUM_PROXY_CREATION_CODE_HASH

    expectedAddress = await utils.createDefaultProxy(
      expectedSalt, accounts[0], authereumProxyFactoryLogicContract,
      AUTH_KEYS[0], label, authereumAccountLogicContract.address
    )

    // Wrap in truffle-contract
    authereumProxy = await ArtifactAuthereumProxy.at(expectedAddress)
    authereumProxyAccount = await ArtifactAuthereumAccount.at(expectedAddress)


    // // Send relayer ETH to use as a transaction fee
    // await authereumProxyAccount.sendTransaction({ value:constants.TWO_ETHER, from: AUTH_KEYS[0] })

    // Default transaction data
    nonce = await authereumProxyAccount.nonce()
    nonce = nonce.toNumber()
    destination = RECEIVERS[0]
    value = 0
    gasLimit = constants.GAS_LIMIT
    data = '0x00'
    gasPrice = constants.GAS_PRICE
    gasOverhead = constants.DEFAULT_GAS_OVERHEAD
    loginKeyRestrictionsData = constants.DEFAULT_LOGIN_KEY_RESTRICTIONS_DATA
    feeTokenAddress = constants.ZERO_ADDRESS
    feeTokenRate = constants.DEFAULT_TOKEN_RATE

    // Convert to transactions array
    encodedParameters = await utils.encodeTransactionParams(destination, value, gasLimit, data)
    transactions = [encodedParameters]

    // Get default signedMessageHash and signedLoginKey
    transactionMessageHashSignature = await utils.getAuthKeySignedMessageHash(
      authereumProxyAccount.address,
      MSG_SIG,
      constants.CHAIN_ID,
      nonce,
      transactions,
      gasPrice,
      gasOverhead,
      feeTokenAddress,
      feeTokenRate
    )

    loginKeyAttestationSignature = utils.getSignedLoginKey(LOGIN_KEYS[0], loginKeyRestrictionsData)
  })

  // Take snapshot before each test and revert after each test
  beforeEach(async() => {
    snapshotId = await timeUtils.takeSnapshot();
  });

  afterEach(async() => {
    await timeUtils.revertSnapshot(snapshotId.result);
  });

  //**********//
  //  Tests  //
  //********//

  describe('fallback', () => {
    it('Should allow anyone to send funds to the contract', async () => {
      await authereumProxyAccount.sendTransaction({ value: constants.ONE_ETHER, from: AUTH_KEYS[1] })
      let accountBalance = await balance.current(authereumProxyAccount.address)
      assert.equal(Number(accountBalance), constants.ONE_ETHER)
      await authereumProxyAccount.sendTransaction({ value: constants.TWO_ETHER, from: RELAYER })
      accountBalance = await balance.current(authereumProxyAccount.address)
      assert.equal(Number(accountBalance), constants.THREE_ETHER)
      await authereumProxyAccount.sendTransaction({ value: constants.ONE_ETHER, from: OWNER })
      accountBalance = await balance.current(authereumProxyAccount.address)
      assert.equal(Number(accountBalance), constants.FOUR_ETHER)
    })
    it('Should use exactly 21084/21084 gas (depending on the fork) on a transaction with no data', async () => {
      // The forkId and variable expected gas is required here due to the gas
      // changes in Istanbul (specifically EIP EIP-1884).
      // The forkId is custom and iplemented in the `npm run ganache` and
      // `npm run ganache-istanbul` scripts.
      // Pre-istanbul ID = 1234
      // Post-istanbul ID = 5678
      const forkId = await web3.eth.net.getId()

      // NOTE: These are expected to be the same cost both pre and post Istanbul.
      // NOTE: This is because this is a simple `send` or `transfer` with no data.
      // NOTE: This type of transaction simply returns and does nothing else.
      let expectedGas
      if (forkId === 1234) {
        expectedGas = 21084
      } else if (forkId === 5678) {
        expectedGas = 21084
      }

      // NOTE: There is a bug in Truffle that causes data to not be sent
      // NOTE: with the transaction when sending with truffle-contracts.
      // NOTE: This web3 call is a workaround to that bug
      // NOTE: https://github.com/trufflesuite/truffle/pull/2275
      const transaction = await web3.eth.sendTransaction({
         from: AUTH_KEYS[0], to: authereumProxyAccount.address, value: constants.ONE_ETHER
      })
      assert.equal(transaction.gasUsed, expectedGas)
    })
    it('Should use exactly 22654/23276 gas (depending on the fork) on a transaction with data', async () => {
      // The forkId and variable expected gas is required here due to the gas
      // changes in Istanbul (specifically EIP EIP-1884).
      // The forkId is custom and iplemented in the `npm run ganache` and
      // `npm run ganache-istanbul` scripts.
      // Pre-istanbul ID = 1234
      // Post-istanbul ID = 5678
      const forkId = await web3.eth.net.getId()
      let expectedGas
      if (forkId === 1234) {
        expectedGas = 22654
      } else if (forkId === 5678) {
        expectedGas = 23276
      }

      // NOTE: There is a bug in Truffle that causes data to not be sent
      // NOTE: with the transaction when sending with truffle-contracts.
      // NOTE: This web3 call is a workaround to that bug
      // NOTE: https://github.com/trufflesuite/truffle/pull/2275
      const transaction = await web3.eth.sendTransaction({
         from: AUTH_KEYS[0], to: authereumProxyAccount.address, value: constants.ONE_ETHER, data: '0xd3e90b01'
      })
      assert.equal(transaction.gasUsed, expectedGas)
    })
  })
  describe('getChainId', () => {
    it('Should return a chain ID of 1', async () => {
      const _chainId = await authereumProxyAccount.getChainId()
      assert.equal(_chainId, constants.CHAIN_ID)
    })
  })
  describe('addAuthKey', () => {
    context('Happy Path', async () => {
      it('Should add an authKey', async () => {
        var { logs } = await authereumProxyAccount.addAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })
        const authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(authKey, true)
        expectEvent.inLogs(logs, 'AuthKeyAdded', { authKey: AUTH_KEYS[1] })

        const numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 2)
      })
      it('Should add two authKeys', async () => {
        var { logs } = await authereumProxyAccount.addAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })
        const authKey1 = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(authKey1, true)
        expectEvent.inLogs(logs, 'AuthKeyAdded', { authKey: AUTH_KEYS[1] })

        let numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 2)

        var { logs } = await authereumProxyAccount.addAuthKey(AUTH_KEYS[2], { from: AUTH_KEYS[0] })
        const authKey2 = await authereumProxyAccount.authKeys(AUTH_KEYS[2])
        assert.equal(authKey2, true)
        expectEvent.inLogs(logs, 'AuthKeyAdded', { authKey: AUTH_KEYS[2] })

        numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 3)
      })
      it('Should add an authKey through executeMultipleAuthKeyMetaTransactions', async () => {
        // Confirm that auth key is not yet added
        let _authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(_authKey, false)

        // Set up transaction to add an auth key
        const _destination = authereumProxyAccount.address
        const _data = await web3.eth.abi.encodeFunctionCall({
          name: 'addAuthKey',
          type: 'function',
          inputs: [{
              type: 'address',
              name: '_authKey'
          }]
          }, [AUTH_KEYS[1]])

        // Convert to transactions array
        const _encodedParameters = await utils.encodeTransactionParams(_destination, value, gasLimit, _data)
        const _transactions = [_encodedParameters]

        // Get default signedMessageHash and signedLoginKey
        const _transactionMessageHashSignature = await utils.getAuthKeySignedMessageHash(
          authereumProxyAccount.address,
          MSG_SIG,
          constants.CHAIN_ID,
          nonce,
          _transactions,
          gasPrice,
          gasOverhead,
          feeTokenAddress,
          feeTokenRate
        )

        var { logs } = await authereumProxyAccount.executeMultipleAuthKeyMetaTransactions(
          _transactions, gasPrice, gasOverhead, feeTokenAddress, feeTokenRate, _transactionMessageHashSignature, { from: RELAYER, gasPrice: gasPrice }
        )

        // Confirm that auth key has been added
        _authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(_authKey, true)
        expectEvent.inLogs(logs, 'AuthKeyAdded', { authKey: AUTH_KEYS[1] })

        const numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 2)
      })
    })
    context('Non-happy Path', async () => {
      it('Should not add the same authKey twice', async () => {
        await expectRevert(authereumProxyAccount.addAuthKey(AUTH_KEYS[0], { from: AUTH_KEYS[0] }), constants.REVERT_MSG.BA_AUTH_KEY_ALREADY_ADDED)
      })
      it('Should not allow a random address to add an auth key', async () => {
        await expectRevert(authereumProxyAccount.addAuthKey(AUTH_KEYS[0], { from: accounts[8] }), constants.REVERT_MSG.BA_REQUIRE_AUTH_KEY_OR_SELF)
      })
      it('Should not allow an arbitrary address to add an authKey (directly)', async () => {
        await expectRevert(authereumProxyAccount.addAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[1] }), constants.REVERT_MSG.BA_REQUIRE_AUTH_KEY_OR_SELF)
      })
      it('Should not allow an arbitrary address to add an authKey through executeMultipleAuthKeyMetaTransactions', async () => {
        // Confirm that auth key is not yet added
        let _authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(_authKey, false)

        // Set up transaction to add an auth key
        const _destination = authereumProxyAccount.address
        const _data = await web3.eth.abi.encodeFunctionCall({
          name: 'addAuthKey',
          type: 'function',
          inputs: [{
              type: 'address',
              name: '_authKey'
          }]
          }, [accounts[9]])

        // Convert to transactions array
        const _encodedParameters = await utils.encodeTransactionParams(_destination, value, gasLimit, _data)
        const _transactions = [_encodedParameters]

        // Get default signedMessageHash and signedLoginKey
        // NOTE: The signing is done here manually (as oppsoed to calling utils.getAuthKeySignedMessageHash()) in
        // order to sign with the malicious signer
        let encodedParams = await web3.eth.abi.encodeParameters(
          ['address', 'bytes4', 'uint256', 'uint256', 'bytes[]', 'uint256', 'uint256', 'address', 'uint256'],
          [
            authereumProxyAccount.address,
            MSG_SIG,
            constants.CHAIN_ID,
            nonce,
            _transactions,
            gasPrice,
            gasOverhead,
            feeTokenAddress,
            feeTokenRate
          ]
        )
        let unsignedMessageHash = await web3.utils.soliditySha3(encodedParams)
        const MALICIOUS_PRIV_KEY = '0xb0057716d5917badaf911b193b12b910811c1497b5bada8d7711f758981c3773'
        let sigedMsg = web3.eth.accounts.sign(unsignedMessageHash, MALICIOUS_PRIV_KEY)
        const _transactionMessageHashSignature = sigedMsg.signature

        await expectRevert(authereumProxyAccount.executeMultipleAuthKeyMetaTransactions(
          _transactions, gasPrice, gasOverhead, feeTokenAddress, feeTokenRate, _transactionMessageHashSignature, { from: RELAYER, gasPrice: gasPrice }
        ), constants.REVERT_MSG.AKMTA_AUTH_KEY_INVALID)
      })
      it('Should not allow a loginKey to add an authKey through executeMultipleLoginKeyMetaTransactions', async () => {
        // Confirm that auth key is not yet added
        let _authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(_authKey, false)

        // Set up transaction to add an auth key
        const _destination = authereumProxyAccount.address
        const _data = await web3.eth.abi.encodeFunctionCall({
          name: 'addAuthKey',
          type: 'function',
          inputs: [{
              type: 'address',
              name: '_authKey'
          }]
          }, [AUTH_KEYS[1]])

        // Convert to transactions array
        const _encodedParameters = await utils.encodeTransactionParams(_destination, value, gasLimit, _data)
        const _transactions = [_encodedParameters]

        // Get default signedMessageHash and signedLoginKey
        const _transactionMessageHashSignature = await utils.getLoginKeySignedMessageHash(
          authereumProxyAccount.address,
          MSG_SIG,
          constants.CHAIN_ID,
          nonce,
          _transactions,
          gasPrice,
          gasOverhead,
          feeTokenAddress,
          feeTokenRate
        )

        await expectRevert(authereumProxyAccount.executeMultipleLoginKeyMetaTransactions(
          _transactions, gasPrice, gasOverhead, loginKeyRestrictionsData, feeTokenAddress, feeTokenRate, _transactionMessageHashSignature, loginKeyAttestationSignature, { from: RELAYER, gasPrice: gasPrice }
        ), constants.REVERT_MSG.LKMTA_LOGIN_KEY_NOT_ABLE_TO_CALL_SELF)
      })
    })
  })
  describe('removeAuthKey', () => {
    context('Happy Path', async () => {
      it('Should remove an authKey', async () => {
        // Add
        var { logs } = await authereumProxyAccount.addAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })
        let authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(authKey, true)
        expectEvent.inLogs(logs, 'AuthKeyAdded', { authKey: AUTH_KEYS[1] })

        let numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 2)

        // Remove
        var { logs } = await authereumProxyAccount.removeAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })
        authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(authKey, false)
        expectEvent.inLogs(logs, 'AuthKeyRemoved', { authKey: AUTH_KEYS[1] })

        numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 1)
      })
      it('Should add two authKeys and then remove two authKeys', async () => {
        // Add
        var { logs } = await authereumProxyAccount.addAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })
        let authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(authKey, true)
        expectEvent.inLogs(logs, 'AuthKeyAdded', { authKey: AUTH_KEYS[1] })

        let numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 2)

        var { logs } = await authereumProxyAccount.addAuthKey(AUTH_KEYS[2], { from: AUTH_KEYS[0] })
        authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[2])
        assert.equal(authKey, true)
        expectEvent.inLogs(logs, 'AuthKeyAdded', { authKey: AUTH_KEYS[2] })

        numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 3)

        // Remove
        var { logs } = await authereumProxyAccount.removeAuthKey(AUTH_KEYS[2], { from: AUTH_KEYS[0] })
        authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[2])
        assert.equal(authKey, false)
        expectEvent.inLogs(logs, 'AuthKeyRemoved', { authKey: AUTH_KEYS[2] })

        numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 2)

        var { logs } = await authereumProxyAccount.removeAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })
        authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(authKey, false)
        expectEvent.inLogs(logs, 'AuthKeyRemoved', { authKey: AUTH_KEYS[1] })

        numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 1)
      })
      it('Should add two authKeys and then remove two authKeys in reverse order', async () => {
        // Add
        var { logs } = await authereumProxyAccount.addAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })
        let authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(authKey, true)
        expectEvent.inLogs(logs, 'AuthKeyAdded', { authKey: AUTH_KEYS[1] })

        let numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 2)

        var { logs } = await authereumProxyAccount.addAuthKey(AUTH_KEYS[2], { from: AUTH_KEYS[0] })
        authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[2])
        assert.equal(authKey, true)
        expectEvent.inLogs(logs, 'AuthKeyAdded', { authKey: AUTH_KEYS[2] })

        numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 3)

        // Remove
        var { logs } = await authereumProxyAccount.removeAuthKey(AUTH_KEYS[2], { from: AUTH_KEYS[0] })
        authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[2])
        assert.equal(authKey, false)
        expectEvent.inLogs(logs, 'AuthKeyRemoved', { authKey: AUTH_KEYS[2] })

        numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 2)

        var { logs } = await authereumProxyAccount.removeAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })
        authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(authKey, false)
        expectEvent.inLogs(logs, 'AuthKeyRemoved', { authKey: AUTH_KEYS[1] })

        numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 1)
      })
      it('Should add an authKey and then remove the original authKey', async () => {
        // Add
        var { logs } = await authereumProxyAccount.addAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })
        let authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(authKey, true)
        expectEvent.inLogs(logs, 'AuthKeyAdded', { authKey: AUTH_KEYS[1] })

        let numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 2)

        // Remove
        var { logs } = await authereumProxyAccount.removeAuthKey(AUTH_KEYS[0], { from: AUTH_KEYS[1] })
        authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[0])
        assert.equal(authKey, false)
        expectEvent.inLogs(logs, 'AuthKeyRemoved', { authKey: AUTH_KEYS[0] })

        numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 1)
      })
      it('Should remove an authKey through executeMultipleAuthKeyMetaTransactions', async () => {
        // Add auth key
        var { logs } = await authereumProxyAccount.addAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })

        // Confirm that auth key already added
        let _authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(_authKey, true)

        // Set up transaction to remove an auth key
        const _destination = authereumProxyAccount.address
        const _data = await web3.eth.abi.encodeFunctionCall({
          name: 'removeAuthKey',
          type: 'function',
          inputs: [{
              type: 'address',
              name: '_authKey'
          }]
          }, [AUTH_KEYS[1]])

        // Convert to transactions array
        const _encodedParameters = await utils.encodeTransactionParams(_destination, value, gasLimit, _data)
        const _transactions = [_encodedParameters]

        // Get default signedMessageHash and signedLoginKey
        const _transactionMessageHashSignature = await utils.getAuthKeySignedMessageHash(
          authereumProxyAccount.address,
          MSG_SIG,
          constants.CHAIN_ID,
          nonce,
          _transactions,
          gasPrice,
          gasOverhead,
          feeTokenAddress,
          feeTokenRate
        )

        await authereumProxyAccount.executeMultipleAuthKeyMetaTransactions(
          _transactions, gasPrice, gasOverhead, feeTokenAddress, feeTokenRate, _transactionMessageHashSignature, { from: RELAYER, gasPrice: gasPrice }
        )

        // Confirm that auth key has been removed
        _authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(_authKey, false)
        expectEvent.inLogs(logs, 'AuthKeyAdded', { authKey: AUTH_KEYS[1] })

        const numAuthKeys = await authereumProxyAccount.numAuthKeys()
        assert.equal(numAuthKeys, 1)
      })
    })
    context('Non-Happy Path', async () => {
      it('Should not remove an authKey that was never a added', async () => {
        await expectRevert(authereumProxyAccount.removeAuthKey(AUTH_KEYS[2], { from: AUTH_KEYS[0] }), constants.REVERT_MSG.BA_AUTH_KEY_NOT_YET_ADDED)
      })
      it('Should not allow a user to remove all authKeys', async () => {
        await expectRevert(authereumProxyAccount.removeAuthKey(AUTH_KEYS[0], { from: AUTH_KEYS[0] }), constants.REVERT_MSG.BA_CANNOT_REMOVE_LAST_AUTH_KEY)
      })
      it('Should not allow a random address to remove an auth key', async () => {
        await authereumProxyAccount.addAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })
        await expectRevert(authereumProxyAccount.removeAuthKey(AUTH_KEYS[1], { from: accounts[8] }), constants.REVERT_MSG.BA_REQUIRE_AUTH_KEY_OR_SELF)
      })
      it('Should not allow an arbitrary address to remove an authKey through executeMultipleAuthKeyMetaTransactions', async () => {
        await authereumProxyAccount.addAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })

        // Confirm that auth key is already added
        let _authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(_authKey, true)

        // Set up transaction to add an auth key
        const _destination = authereumProxyAccount.address
        const _data = await web3.eth.abi.encodeFunctionCall({
          name: 'removeAuthKey',
          type: 'function',
          inputs: [{
              type: 'address',
              name: '_authKey'
          }]
          }, [AUTH_KEYS[1]])

        // Convert to transactions array
        const _encodedParameters = await utils.encodeTransactionParams(_destination, value, gasLimit, _data)
        const _transactions = [_encodedParameters]

        // Get default signedMessageHash and signedLoginKey
        // NOTE: The signing is done here manually (as oppsoed to calling utils.getAuthKeySignedMessageHash()) in
        // order to sign with the malicious signer
        let encodedParams = await web3.eth.abi.encodeParameters(
          ['address', 'bytes4', 'uint256', 'uint256', 'bytes[]', 'uint256', 'uint256', 'address', 'uint256'],
          [
            authereumProxyAccount.address,
            MSG_SIG,
            constants.CHAIN_ID,
            nonce,
            _transactions,
            gasPrice,
            gasOverhead,
            feeTokenAddress,
            feeTokenRate
          ]
        )
        let unsignedMessageHash = await web3.utils.soliditySha3(encodedParams)
        const MALICIOUS_PRIV_KEY = '0xb0057716d5917badaf911b193b12b910811c1497b5bada8d7711f758981c3773'
        let sigedMsg = web3.eth.accounts.sign(unsignedMessageHash, MALICIOUS_PRIV_KEY)
        const _transactionMessageHashSignature = sigedMsg.signature

        await expectRevert(authereumProxyAccount.executeMultipleLoginKeyMetaTransactions(
          _transactions, gasPrice, gasOverhead, loginKeyRestrictionsData, feeTokenAddress, feeTokenRate, _transactionMessageHashSignature, loginKeyAttestationSignature, { from: RELAYER, gasPrice: gasPrice }
        ), constants.REVERT_MSG.LKMTA_LOGIN_KEY_NOT_ABLE_TO_CALL_SELF)
      })
      it('Should not allow a loginKey to remove an authKey through executeMultipleLoginKeyMetaTransactions', async () => {
        await authereumProxyAccount.addAuthKey(AUTH_KEYS[1], { from: AUTH_KEYS[0] })

        // Confirm that auth key is already added
        let _authKey = await authereumProxyAccount.authKeys(AUTH_KEYS[1])
        assert.equal(_authKey, true)

        // Set up transaction to add an auth key
        const _destination = authereumProxyAccount.address
        const _data = await web3.eth.abi.encodeFunctionCall({
          name: 'removeAuthKey',
          type: 'function',
          inputs: [{
              type: 'address',
              name: '_authKey'
          }]
          }, [AUTH_KEYS[1]])

        // Convert to transactions array
        const _encodedParameters = await utils.encodeTransactionParams(_destination, value, gasLimit, _data)
        const _transactions = [_encodedParameters]

        // Get default signedMessageHash and signedLoginKey
        const _transactionMessageHashSignature = await utils.getLoginKeySignedMessageHash(
          authereumProxyAccount.address,
          MSG_SIG,
          constants.CHAIN_ID,
          nonce,
          _transactions,
          gasPrice,
          gasOverhead,
          feeTokenAddress,
          feeTokenRate
        )

        await expectRevert(authereumProxyAccount.executeMultipleLoginKeyMetaTransactions(
          _transactions, gasPrice, gasOverhead, loginKeyRestrictionsData, feeTokenAddress, feeTokenRate, _transactionMessageHashSignature, loginKeyAttestationSignature, { from: RELAYER, gasPrice: gasPrice }
        ), constants.REVERT_MSG.LKMTA_LOGIN_KEY_NOT_ABLE_TO_CALL_SELF)
      })
    })
  })
})
