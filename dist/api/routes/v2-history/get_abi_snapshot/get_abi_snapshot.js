import { timedQuery } from "../../../helpers/functions.js";
async function getAbiSnapshot(fastify, request) {
    const response = {
        block_num: null
    };
    const query = request.query;
    const code = query.contract;
    const block = query.block;
    const should_fetch = query.fetch;
    const mustArray = [];
    mustArray.push({ "term": { "account": code } });
    if (block) {
        mustArray.push({ "range": { "block": { "lte": parseInt(block) } } });
    }
    const results = await fastify.elastic.search({
        index: fastify.manager.chain + '-abi-*',
        size: 1,
        body: {
            query: { bool: { must: mustArray } },
            sort: [{ block: { order: "desc" } }]
        }
    });
    if (results['body']['hits']['hits'].length > 0) {
        if (should_fetch) {
            response['abi'] = JSON.parse(results['body']['hits']['hits'][0]['_source']['abi']);
        }
        else {
            response['present'] = true;
        }
        response.block_num = results['body']['hits']['hits'][0]['_source']['block'];
    }
    else {
        response['present'] = false;
        response['error'] = 'abi not found for ' + code + ' until block ' + block;
    }
    return response;
}
export function getAbiSnapshotHandler(fastify, route) {
    return async (request, reply) => {
        reply.send(await timedQuery(getAbiSnapshot, fastify, request, route));
    };
}
