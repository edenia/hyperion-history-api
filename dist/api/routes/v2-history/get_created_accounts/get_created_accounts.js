import { timedQuery } from "../../../helpers/functions.js";
import { getSkipLimit } from "../get_actions/functions.js";
async function getCreatedAccounts(fastify, request) {
    const query = request.query;
    const { skip, limit } = getSkipLimit(query);
    const maxActions = fastify.manager.config.api.limits.get_created_accounts;
    const results = await fastify.elastic.search({
        index: fastify.manager.chain + '-action-*',
        from: skip || 0,
        size: (maxActions && (limit > maxActions) ? maxActions : limit) || 100,
        query: {
            bool: {
                must: [
                    { term: { "act.authorization.actor": query.account.toLowerCase() } },
                    { term: { "act.name": "newaccount" } },
                    { term: { "act.account": "eosio" } }
                ]
            }
        },
        sort: ["global_sequence:desc"]
    });
    const response = { accounts: [] };
    if (results['body']['hits']['hits'].length > 0) {
        const actions = results['body']['hits']['hits'];
        for (let action of actions) {
            action = action._source;
            const _tmp = {};
            if (action['act']['data']['newact']) {
                _tmp['name'] = action['act']['data']['newact'];
            }
            else if (action['@newaccount']['newact']) {
                _tmp['name'] = action['@newaccount']['newact'];
            }
            else {
                console.log(action);
            }
            _tmp['trx_id'] = action['trx_id'];
            _tmp['timestamp'] = action['@timestamp'];
            response.accounts.push(_tmp);
        }
    }
    return response;
}
export function getCreatedAccountsHandler(fastify, route) {
    return async (request, reply) => {
        reply.send(await timedQuery(getCreatedAccounts, fastify, request, route));
    };
}
