import axios from 'axios';
import {
  pipe,
  toPairs,
  groupBy,
  chain,
  pluck,
  head,
  map,
  assoc,
  last,
  mapObjIndexed,
  values,
  isEmpty,
  contains,
} from 'ramda';
import moment from 'moment';
import { offsetToCursor } from 'graphql-relay';
import { cursorToOffset } from 'graphql-relay/lib/connection/arrayconnection';
import conf from '../config/conf';
import { FunctionalError } from '../config/errors';

const gkDateFormat = 'YYYY-MM-DDTHH:mm:ss';
export const gkString = 'java.lang.String';
const gkDate = 'java.time.LocalDateTime';
export const now = () =>
  moment()
    .utc()
    .format(gkDateFormat); // Format that accept grakn

const multipleAttributes = ['stix_label'];

const instance = axios.create({
  baseURL: conf.get('grakn:baseURL'),
  timeout: conf.get('grakn:timeout')
});

export const qk = queryDef =>
  instance({
    method: 'post',
    url: '/kb/grakn/graql',
    data: queryDef
  }).catch(() => {
    console.error('GRAKN QUERY ERROR', queryDef);
  });

const attrByID = id => instance({ method: 'get', url: `${id}/attributes` });

const attrMap = (id, res, withType = false) => {
  const transform = pipe(
    map(attr => {
      let transformedVal = attr.value;
      const type = attr['data-type'];
      if (type === gkDate) {
        // Patch for grakn LocalDate.
        transformedVal = `${moment(attr.value).format(gkDateFormat)}Z`;
      }
      return {
        [attr.type.label]: withType
          ? { type, val: transformedVal }
          : transformedVal
      };
    }), // Extract values
    chain(toPairs), // Convert to pairs for grouping
    groupBy(head), // Group by key
    map(pluck(1)), // Remove grouping boilerplate
    mapObjIndexed((num, key, obj) =>
      obj[key].length === 1 && !contains(key, multipleAttributes) ? head(obj[key]): obj[key]
    ) // Remove extra list then contains only 1 element
  )(res.data.attributes);
  return Promise.resolve(assoc('id', id, transform));
};

export const deleteByID = id => {
  const delUser = qk(`match $x id ${id}; delete $x;`);
  return delUser.then(result => {
    if (isEmpty(result.data)) {
      throw new FunctionalError({ message: "User doesn't exist" });
    } else {
      return id;
    }
  });
};

// id must be VXXXXX
export const loadByID = (id, withType = false) =>
  qk(`match $x id ${id}; get;`).then(
    result =>
      Promise.all(
        map(line =>
          attrByID(line.x['@id']).then(res => attrMap(id, res, withType))
        )(result.data)
      ).then(r => head(r)) // Return the unique result
  );

export const loadAll = (
  type = 'User',
  first = 25,
  after = undefined,
  orderBy = undefined
) => {
  const offset = after ? cursorToOffset(after) : 0;
  const loadCount = qk(`match $count isa ${type}; aggregate count;`).then(
    result => head(result.data)
  );
  const loadElements = qk(
    `match $x isa ${type}; offset ${offset}; limit ${first}; get;`
  ).then(result =>
    Promise.all(
      map(line => attrByID(line.x['@id']).then(res => attrMap(line.x.id, res)))(
        result.data
      )
    )
  );
  return Promise.all([loadCount, loadElements]).then(mergedData => {
    const globalCount = head(mergedData);
    const malwares = last(mergedData);
    const edges = pipe(
      mapObjIndexed((record, key) => {
        const node = record;
        const nodeOffset = offset + parseInt(key, 10) + 1;
        return { node, cursor: offsetToCursor(nodeOffset) };
      }),
      values
    )(malwares);
    const hasNextPage = first + offset < globalCount;
    const hasPreviousPage = offset > 0;
    const startCursor = head(edges).cursor;
    const endCursor = last(edges).cursor;
    const pageInfo = {
      startCursor,
      endCursor,
      hasNextPage,
      hasPreviousPage,
      globalCount
    };
    return { edges, pageInfo };
  });
};

export default instance;
