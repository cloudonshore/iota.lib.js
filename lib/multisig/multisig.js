var Signing = require("../crypto/signing/signing");
var Converter = require("../crypto/converter/converter");
var Kerl = require("../crypto/kerl/kerl");
var Bundle = require("../crypto/bundle/bundle");
var Utils = require("../utils/utils");
var inputValidator = require("../utils/inputValidator");
var errors = require("../errors/inputErrors");
var Address = require("./address");

function Multisig(provider) {
  this._makeRequest = provider;
}

/**
*   Gets the key value of a seed
*
*   @method getKey
*   @param {string} seed
*   @param {int} index
*   @param {int} security Security level to be used for the private key / address. Can be 1, 2 or 3
*   @returns {string} digest trytes
**/
Multisig.prototype.getKey = function(seed, index, security) {
  return Converter.trytes(Signing.key(Converter.trits(seed), index, security));
};

/**
*   Gets the digest value of a seed
*
*   @method getDigest
*   @param {string} seed
*   @param {int} index
*   @param {int} security Security level to be used for the private key / address. Can be 1, 2 or 3
*   @returns {string} digest trytes
**/
Multisig.prototype.getDigest = function(seed, index, security) {
  var key = Signing.key(Converter.trits(seed), index, security);
  return Converter.trytes(Signing.digests(key));
};

/**
*   Multisig address constructor
*/
Multisig.prototype.address = Address;

/**
*   Validates  a generated multisig address
*
*   @method validateAddress
*   @param {string} multisigAddress
*   @param {array} digests
*   @returns {bool}
**/
Multisig.prototype.validateAddress = function(multisigAddress, digests) {
  var kerl = new Kerl();

  // initialize Kerl with the provided state
  kerl.initialize();

  // Absorb all key digests
  digests.forEach(function(keyDigest) {
    var trits = Converter.trits(keyDigest);
    kerl.absorb(Converter.trits(keyDigest), 0, trits.length);
  });

  // Squeeze address trits
  var addressTrits = [];
  kerl.squeeze(addressTrits, 0, kerl.HASH_LENGTH);

  // Convert trits into trytes and return the address
  return Converter.trytes(addressTrits) === multisigAddress;
};

/**
*   Prepares transfer by generating the bundle with the corresponding cosigner transactions
*   Does not contain signatures
*
*   @method initiateTransfer
*   @param {int} securitySum sum of security levels used by all co-signers
*   @param {array} inputAddress array of input addresses as well as the securitySum
*   @param {string} remainderAddress Has to be generated by the cosigners before initiating the transfer, can be null if fully spent
*   @param {object} transfers
*   @param {function} callback
*   @returns {array} Array of transaction objects
**/
Multisig.prototype.initiateTransfer = function(
  securitySum,
  inputAddress,
  remainderAddress,
  transfers,
  callback
) {
  var self = this;

  // If message or tag is not supplied, provide it
  // Also remove the checksum of the address if it's there
  transfers.forEach(function(thisTransfer) {
    thisTransfer.message = thisTransfer.message ? thisTransfer.message : "";
    thisTransfer.tag = thisTransfer.tag ? thisTransfer.tag : "";
    thisTransfer.address = Utils.noChecksum(thisTransfer.address);
  });

  // Input validation of transfers object
  if (!inputValidator.isTransfersArray(transfers)) {
    return callback(errors.invalidTransfers());
  }

  // check if int
  if (!inputValidator.isValue(securitySum)) {
    return callback(errors.invalidInputs());
  }

  // validate input address
  if (!inputValidator.isAddress(inputAddress)) {
    return callback(errors.invalidTrytes());
  }

  // validate remainder address
  if (remainderAddress && !inputValidator.isAddress(remainderAddress)) {
    return callback(errors.invalidTrytes());
  }

  // Create a new bundle
  var bundle = new Bundle();

  var totalValue = 0;
  var signatureFragments = [];
  var tag;

  //
  //  Iterate over all transfers, get totalValue
  //  and prepare the signatureFragments, message and tag
  //
  for (var i = 0; i < transfers.length; i++) {
    var signatureMessageLength = 1;

    // If message longer than 2187 trytes, increase signatureMessageLength (add multiple transactions)
    if (transfers[i].message.length > 2187) {
      // Get total length, message / maxLength (2187 trytes)
      signatureMessageLength += Math.floor(transfers[i].message.length / 2187);

      var msgCopy = transfers[i].message;

      // While there is still a message, copy it
      while (msgCopy) {
        var fragment = msgCopy.slice(0, 2187);
        msgCopy = msgCopy.slice(2187, msgCopy.length);

        // Pad remainder of fragment
        for (var j = 0; fragment.length < 2187; j++) {
          fragment += "9";
        }

        signatureFragments.push(fragment);
      }
    } else {
      // Else, get single fragment with 2187 of 9's trytes
      var fragment = "";

      if (transfers[i].message) {
        fragment = transfers[i].message.slice(0, 2187);
      }

      for (var j = 0; fragment.length < 2187; j++) {
        fragment += "9";
      }

      signatureFragments.push(fragment);
    }

    // get current timestamp in seconds
    var timestamp = Math.floor(Date.now() / 1000);

    // If no tag defined, get 27 tryte tag.
    tag = transfers[i].tag ? transfers[i].tag : "999999999999999999999999999";

    // Pad for required 27 tryte length
    for (var j = 0; tag.length < 27; j++) {
      tag += "9";
    }

    // Add first entries to the bundle
    // Slice the address in case the user provided a checksummed one
    bundle.addEntry(
      signatureMessageLength,
      transfers[i].address.slice(0, 81),
      transfers[i].value,
      tag,
      timestamp
    );

    // Sum up total value
    totalValue += parseInt(transfers[i].value);
  }

  // Get inputs if we are sending tokens

  // Get inputs if we are sending tokens
  if (totalValue) {
    var command = {
      command: "getBalances",
      addresses: new Array(inputAddress),
      threshold: 100
    };

    self._makeRequest.send(command, function(e, balances) {
      if (e) return callback(e);

      var totalBalance = parseInt(balances.balances[0]);

      if (totalBalance > 0) {
        var toSubtract = 0 - totalBalance;
        var timestamp = Math.floor(Date.now() / 1000);

        // Add input as bundle entry
        // Only a single entry, signatures will be added later
        bundle.addEntry(securitySum, inputAddress, toSubtract, tag, timestamp);
      }

      if (totalValue > totalBalance) {
        return callback(new Error("Not enough balance."));
      }

      // If there is a remainder value
      // Add extra output to send remaining funds to
      if (totalBalance > totalValue) {
        var remainder = totalBalance - totalValue;

        // Remainder bundle entry if necessary
        if (!remainderAddress) {
          return callback(new Error("No remainder address defined"));
        }

        bundle.addEntry(1, remainderAddress, remainder, tag, timestamp);
      }

      bundle.finalize();
      bundle.addTrytes(signatureFragments);

      return callback(null, bundle.bundle);
    });
  } else {
    return callback(
      new Error(
        "Invalid value transfer: the transfer does not require a signature."
      )
    );
  }
};

/**
*   Adds the cosigner signatures to the corresponding bundle transaction
*
*   @method addSignature
*   @param {array} bundleToSign
*   @param {int} cosignerIndex
*   @param {string} inputAddress
*   @param {string} key
*   @param {function} callback
*   @returns {array} trytes Returns bundle trytes
**/
Multisig.prototype.addSignature = function(
  bundleToSign,
  inputAddress,
  key,
  callback
) {
  var bundle = new Bundle();
  bundle.bundle = bundleToSign;

  // Get the security used for the private key
  // 1 security level = 2187 trytes
  var security = key.length / 2187;

  // convert private key trytes into trits
  var key = Converter.trits(key);

  // First get the total number of already signed transactions
  // use that for the bundle hash calculation as well as knowing
  // where to add the signature
  var numSignedTxs = 0;

  for (var i = 0; i < bundle.bundle.length; i++) {
    if (bundle.bundle[i].address === inputAddress) {
      // If transaction is already signed, increase counter
      if (
        !inputValidator.isNinesTrytes(bundle.bundle[i].signatureMessageFragment)
      ) {
        numSignedTxs++;
      } else {
        // Else sign the transactionse
        var bundleHash = bundle.bundle[i].bundle;

        //  First 6561 trits for the firstFragment
        var firstFragment = key.slice(0, 6561);

        //  Get the normalized bundle hash
        var normalizedBundleHash = bundle.normalizedBundle(bundleHash);
        var normalizedBundleFragments = [];

        // Split hash into 3 fragments
        for (var k = 0; k < 3; k++) {
          normalizedBundleFragments[k] = normalizedBundleHash.slice(
            k * 27,
            (k + 1) * 27
          );
        }

        //  First bundle fragment uses 27 trytes
        var firstBundleFragment = normalizedBundleFragments[numSignedTxs % 3];

        //  Calculate the new signatureFragment with the first bundle fragment
        var firstSignedFragment = Signing.signatureFragment(
          firstBundleFragment,
          firstFragment
        );

        //  Convert signature to trytes and assign the new signatureFragment
        bundle.bundle[i].signatureMessageFragment = Converter.trytes(
          firstSignedFragment
        );

        for (var j = 1; j < security; j++) {
          //  Next 6561 trits for the firstFragment
          var nextFragment = key.slice(6561 * j, (j + 1) * 6561);

          //  Use the next 27 trytes
          var nextBundleFragment =
            normalizedBundleFragments[(numSignedTxs + j) % 3];

          //  Calculate the new signatureFragment with the first bundle fragment
          var nextSignedFragment = Signing.signatureFragment(
            nextBundleFragment,
            nextFragment
          );

          //  Convert signature to trytes and add new bundle entry at i + j position
          // Assign the signature fragment
          bundle.bundle[i + j].signatureMessageFragment = Converter.trytes(
            nextSignedFragment
          );
        }

        break;
      }
    }
  }

  return callback(null, bundle.bundle);
};

module.exports = Multisig;
