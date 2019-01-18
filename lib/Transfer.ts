// Copyright (c) 2018, Zpalmtree
//
// Please see the included LICENSE file for more information.

import deepEqual = require('deep-equal');

import * as _ from 'lodash';

import {
    CreatedTransaction, DecodedAddress, Output, RandomOutput, TxDestination, Wallet,
} from 'turtlecoin-utils';

import { CryptoUtils } from './CnUtils';
import { IDaemon } from './IDaemon';
import { LogCategory, logger, LogLevel } from './Logger';
import { SubWallets } from './SubWallets';
import { TxInputAndOwner } from './Types';
import { prettyPrintAmount } from './Utilities';

import {
    validateAddresses, validateAmount, validateDestinations,
    validateIntegratedAddresses, validateMixin, validateOurAddresses,
    validatePaymentID,
} from './ValidateParameters';

import { SUCCESS, WalletError, WalletErrorCode } from './WalletError';

import config from './Config';

/**
 * Sends a transaction of amount to the address destination, using the
 * given payment ID, if specified.
 *
 * Network fee is set to default, mixin is set to default, all subwallets
 * are taken from, primary address is used as change address.
 *
 * If you need more control, use `sendTransactionAdvanced()`
 *
 * @param destination   The address to send the funds to
 * @param amount        The amount to send, in ATOMIC units
 * @param paymentID     The payment ID to include with this transaction. Optional.
 *
 * @return Returns either an error, or the transaction hash.
 */
export async function sendTransactionBasic(
    daemon: IDaemon,
    subWallets: SubWallets,
    destination: string,
    amount: number,
    paymentID?: string): Promise<WalletError | string> {

    return sendTransactionAdvanced(
        daemon,
        subWallets,
        [[destination, amount]],
        undefined,
        undefined,
        paymentID,
    );
}

/**
 * Sends a transaction, which permits multiple amounts to different destinations,
 * specifying the mixin, fee, subwallets to draw funds from, and change address.
 *
 * All parameters are optional aside from daemon, subWallets, and addressesAndAmounts.
 *
 * @param addressesAndAmounts   An array of destinations, and amounts to send to that
 *                              destination.
 * @param mixin                 The amount of input keys to hide your input with.
 *                              Your network may enforce a static mixin.
 * @param fee                   The network fee to use with this transaction. In ATOMIC units.
 * @param paymentID             The payment ID to include with this transaction.
 * @param subWalletsToTakeFrom  The addresses of the subwallets to draw funds from.
 * @param changeAddress         The address to send any returned change to.
 */
export async function sendTransactionAdvanced(
    daemon: IDaemon,
    subWallets: SubWallets,
    addressesAndAmounts: Array<[string, number]>,
    mixin?: number,
    fee?: number,
    paymentID?: string,
    subWalletsToTakeFrom?: string[],
    changeAddress?: string): Promise<WalletError | string> {

    if (mixin === undefined) {
        mixin = config.mixinLimits.getDefaultMixinByHeight(
            daemon.getNetworkBlockCount(),
        );
    }

    if (fee === undefined) {
        fee = config.minimumFee;
    }

    if (paymentID === undefined) {
        paymentID = '';
    }

    if (subWalletsToTakeFrom === undefined || subWalletsToTakeFrom.length === 0) {
        subWalletsToTakeFrom = subWallets.getAddresses();
    }

    if (changeAddress === undefined || changeAddress === '') {
        changeAddress = subWallets.getPrimaryAddress();
    }

    const [feeAddress, feeAmount] = daemon.nodeFee();

    /* Add the node fee, if it exists */
    if (feeAmount !== 0) {
        addressesAndAmounts.push([feeAddress, feeAmount]);
    }

    const error: WalletError = validateTransaction(
        addressesAndAmounts, mixin, fee, paymentID, subWalletsToTakeFrom,
        changeAddress, daemon.getNetworkBlockCount(), subWallets,
    );

    if (!deepEqual(error, SUCCESS)) {
        return error;
    }

    const tmp: Array<[string, number]> = [];

    const totalAmount: number = _.sumBy(
        addressesAndAmounts, ([address, amount]) => amount,
    ) + fee;

    /* Prepare destinations keys */
    const transfers: TxDestination[] = addressesAndAmounts.map(([address, amount]) => {
        const decoded: DecodedAddress = CryptoUtils.decodeAddress(address);

        /* Assign payment ID from integrated address is present */
        if (decoded.paymentId !== '') {
            paymentID = decoded.paymentId;
        }

        return {
            amount: amount,
            keys: decoded,
        };
    });

    const [inputs, foundMoney] = subWallets.getTransactionInputsForAmount(
        totalAmount, subWalletsToTakeFrom, daemon.getNetworkBlockCount(),
    );

    const ourOutputs: Output[] = inputs.map((input) => {

        const [keyImage, tmpSecretKey] = CryptoUtils.generateKeyImage(
            input.input.transactionPublicKey,
            subWallets.getPrivateViewKey(),
            input.publicSpendKey,
            input.privateSpendKey,
            input.input.transactionIndex,
        );

        return {
            amount: input.input.amount,
            globalIndex: input.input.globalOutputIndex,
            index: input.input.transactionIndex,
            input: {
                privateEphemeral: tmpSecretKey,
                privateSpendKey: input.privateSpendKey,
                publicSpendKey: input.publicSpendKey,
            },
            key: input.input.key,
            keyImage: keyImage,
        };
    });

    const randomOuts: WalletError | RandomOutput[][] = await getRingParticipants(
        inputs, mixin, daemon,
    );

    if (randomOuts instanceof WalletError) {
        return randomOuts as WalletError;
    }

    let tx: CreatedTransaction;

    try {
        tx = CryptoUtils.createTransaction(
            transfers, ourOutputs, randomOuts as RandomOutput[][], mixin, fee,
            paymentID,
        );
    } catch (err) {
        logger.log(
            'Failed to create transaction: ' + err.toString(),
            LogLevel.ERROR,
            LogCategory.TRANSACTIONS,
        );

        return new WalletError(WalletErrorCode.UNKNOWN_ERROR, err.toString());
    }

    try {
        const relaySuccess: boolean = await daemon.sendTransaction(tx.rawTransaction);

        if (relaySuccess) {
            return tx.hash;
        } else {
            return new WalletError(WalletErrorCode.DAEMON_ERROR);
        }
    /* Timeout */
    } catch (err) {
        return new WalletError(WalletErrorCode.DAEMON_OFFLINE);
    }

    return tx.hash;
}

/**
 * Get sufficient random outputs for the transaction. Returns an error if
 * can't get outputs or can't get enough outputs.
 */
async function getRingParticipants(
    inputs: TxInputAndOwner[],
    mixin: number,
    daemon: IDaemon): Promise<WalletError | RandomOutput[][]> {

    if (mixin === 0) {
        return [];
    }

    /* Request one more than needed, this way if we get our own output as
       one of the mixin outs, we can skip it and still form the transaction */
    const requestedOuts: number = mixin + 1;

    const amounts: number[] = inputs.map((input) => input.input.amount);

    const outs = await daemon.getRandomOutputsByAmount(amounts, mixin);

    if (outs.length === 0) {
        return new WalletError(WalletErrorCode.DAEMON_OFFLINE);
    }

    for (const amount of amounts) {
        /* Check each amount is present in outputs */
        const foundOutputs = _.find(outs, ([outAmount, ignore]) => amount === outAmount);

        if (foundOutputs === undefined) {
            return new WalletError(
                WalletErrorCode.NOT_ENOUGH_FAKE_OUTPUTS,
                `Failed to get any matching outputs for amount ${amount} ` +
                `(${prettyPrintAmount(amount)}). Further explanation here: ` +
                `https://gist.github.com/zpalmtree/80b3e80463225bcfb8f8432043cb594c`,
            );
        }

        if (foundOutputs.length < mixin) {
            return new WalletError(
                WalletErrorCode.NOT_ENOUGH_FAKE_OUTPUTS,
                `Failed to get enough matching outputs for amount ${amount} ` +
                `(${prettyPrintAmount(amount)}). Needed outputs: ${requestedOuts} ` +
                `, found outputs: ${foundOutputs.length}. Further explanation here: ` +
                `https://gist.github.com/zpalmtree/80b3e80463225bcfb8f8432043cb594c`,
            );
        }
    }

    if (outs.length !== amounts.length) {
        return new WalletError(WalletErrorCode.NOT_ENOUGH_FAKE_OUTPUTS);
    }

    const randomOuts: RandomOutput[][] = [];

     /* Do the same check as above here, again. The reason being that
        we just find the first set of outputs matching the amount above,
        and if we requests, say, outputs for the amount 100 twice, the
        first set might be sufficient, but the second are not.

        We could just check here instead of checking above, but then we
        might hit the length message first. Checking this way gives more
        informative errors. */
    for (const [amount, outputs] of outs) {
        if (outputs.length < mixin) {
            return new WalletError(
                WalletErrorCode.NOT_ENOUGH_FAKE_OUTPUTS,
                `Failed to get enough matching outputs for amount ${amount} ` +
                `(${prettyPrintAmount(amount)}). Needed outputs: ${requestedOuts} ` +
                `, found outputs: ${outputs.length}. Further explanation here: ` +
                `https://gist.github.com/zpalmtree/80b3e80463225bcfb8f8432043cb594c`,
            );
        }

        randomOuts.push(outputs.map(([index, key]) => {
            return {
                globalIndex: index,
                key: key,
            };
        }));
    }

    return randomOuts;
}

/**
 * Validate the given transaction parameters are valid.
 *
 * @return Returns either SUCCESS or an error representing the issue
 */
function validateTransaction(
    destinations: Array<[string, number]>,
    mixin: number,
    fee: number,
    paymentID: string,
    subWalletsToTakeFrom: string[],
    changeAddress: string,
    currentHeight: number,
    subWallets: SubWallets) {

    /* Validate the destinations are valid */
    let error: WalletError = validateDestinations(destinations);

    if (!deepEqual(error, SUCCESS)) {
        return error;
    }

    /* Validate stored payment ID's in integrated addresses don't conflict */
    error = validateIntegratedAddresses(destinations, paymentID);

    if (!deepEqual(error, SUCCESS)) {
        return error;
    }

    /* Verify the subwallets to take from exist */
    error = validateOurAddresses(subWalletsToTakeFrom, subWallets);

    if (!deepEqual(error, SUCCESS)) {
        return error;
    }

    /* Verify we have enough money for the transaction */
    error = validateAmount(destinations, fee, subWalletsToTakeFrom, subWallets, currentHeight);

    if (!deepEqual(error, SUCCESS)) {
        return error;
    }

    /* Validate mixin is within the bounds for the current height */
    error = validateMixin(mixin, currentHeight);

    if (!deepEqual(error, SUCCESS)) {
        return error;
    }

    error = validatePaymentID(paymentID);

    if (!deepEqual(error, SUCCESS)) {
        return error;
    }

    error = validateOurAddresses([changeAddress], subWallets);

    if (!deepEqual(error, SUCCESS)) {
        return error;
    }

    return SUCCESS;
}