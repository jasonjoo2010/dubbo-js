/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import debug from 'debug';
import ip from 'ip';
import zookeeper from 'node-zookeeper-client';
import qs from 'querystring';
import DubboUrl from '../dubbo-url';
import {
  ZookeeperDisconnectedError,
  ZookeeperExpiredError,
  ZookeeperTimeoutError,
} from '../err';
import {go} from '../go';
import {
  ICreateConsumerParam,
  IDubboRegistryProps,
  IZkClientProps,
} from '../types';
import {eqSet, isDevEnv, msg, traceErr} from '../util';
import Registry from './registry';

const log = debug('dubbo:zookeeper');
const ipAddress = ip.address();

export class ZkRegistry extends Registry<IZkClientProps & IDubboRegistryProps> {
  constructor(props: IZkClientProps & IDubboRegistryProps) {
    super(props);
    log(`new:|> %O`, props);
    //默认dubbo
    this._props.zkRoot = this._props.zkRoot || 'dubbo';
    //初始化agentAddrSet
    this._agentAddrSet = new Set();
    //初始化zookeeper的client
    this._connect(this._init);
  }

  private _client: zookeeper.Client;
  private _agentAddrSet: Set<string>;

  //========================private method==========================
  private _init = async (err: Error) => {
    //zookeeper occur error
    if (err) {
      log(err);
      traceErr(err);
      this._subscriber.onError(err);
      return;
    }

    //zookeeper connected（may be occur many times）
    const {
      zkRoot,
      application: {name},
      interfaces,
    } = this._props;

    //获取所有provider
    for (let inf of interfaces) {
      //当前接口在zookeeper中的路径
      const dubboServicePath = `/${zkRoot}/${inf}/providers`;
      //当前接口路径下的dubbo url
      const {res: dubboServiceUrls, err} = await go(
        this._getDubboServiceUrls(dubboServicePath, inf),
      );

      if (err) {
        log(`getChildren ${dubboServicePath} error ${err}`);
        traceErr(err);
      }

      //init
      this._dubboServiceUrlMap.set(inf, []);
      for (let serviceUrl of dubboServiceUrls) {
        const url = DubboUrl.from(serviceUrl);
        this._dubboServiceUrlMap.get(inf).push(url);
      }
      //写入consumer信息
      this._createConsumer({
        name: name,
        dubboInterface: inf,
      }).then(() => log('create Consumer finish'));
    }

    if (isDevEnv) {
      log('agentAddrSet: %O', this._allAgentAddrSet);
      log('dubboServiceUrl:|> %O', this._dubboServiceUrlMap);
    }

    this._agentAddrSet = this._allAgentAddrSet;
    this._subscriber.onData(this._allAgentAddrSet);
  };

  /**
   * 获取所有的负载列表，通过agentAddrMap聚合出来
   * 这样有点Reactive的感觉，不需要考虑当中增加删除的动作
   */
  private get _allAgentAddrSet() {
    const agentSet = new Set() as Set<string>;
    for (let urlList of this._dubboServiceUrlMap.values()) {
      for (let url of urlList) {
        agentSet.add(url.host + ':' + url.port);
      }
    }
    return agentSet;
  }

  /**
   * 获取所有的provider列表
   * @param {string} dubboServicePath
   * @param dubboInterface
   * @returns {Promise<Array<string>>}
   * @private
   */
  private async _getDubboServiceUrls(
    dubboServicePath: string,
    dubboInterface: string,
  ): Promise<Array<string>> {
    return this._getChildren(
      dubboServicePath,
      this._watchWrap(dubboServicePath, dubboInterface),
    ).then(res => {
      return (res.children || [])
        .map(child => decodeURIComponent(child))
        .filter(child => child.startsWith('dubbo://'));
    });
  }

  //========================zookeeper helper=========================
  /**
   * connect zookeeper
   */
  private _connect = (callback: (err: Error) => void) => {
    const {url: register} = this._props;
    //debug log
    log(`connecting zkserver ${register}`);
    //connect
    this._client = zookeeper.createClient(register, {
      retries: 10,
    });

    //超时检测
    //node-zookeeper-client,有个bug，当连不上zk时会无限重连
    //手动做一个超时检测
    const timeId = setTimeout(() => {
      log(`Could not connect zk ${register}， time out`);
      this._client.close();
      callback(
        new ZookeeperTimeoutError(
          `ZooKeeper was connected ${register} time out. `,
        ),
      );
    }, 30 * 1000);

    this._client.once('connected', () => {
      log(`connected to zkserver ${register}`);
      clearTimeout(timeId);
      callback(null);
      msg.emit('sys:ready');
    });

    //the connection between client and server is dropped.
    this._client.on('disconnected', () => {
      log(`zk ${register} had disconnected`);
      clearTimeout(timeId);
      callback(
        new ZookeeperDisconnectedError(
          `ZooKeeper was disconnected. current state is ${this._client.getState()} `,
        ),
      );
    });

    this._client.on('expired', () => {
      log(`zk ${register} had session expired`);
      callback(
        new ZookeeperExpiredError(
          `Zookeeper was session Expired Error current state ${this._client.getState()}`,
        ),
      );
    });

    //connect
    this._client.connect();
  };

  private _watchWrap(dubboServicePath: string, dubboInterface: string) {
    return async (e: zookeeper.Event) => {
      log(`trigger watch ${e}`);

      //会有概率性的查询节点为空，可以延时一些时间
      // await delay(2000);

      const {res: dubboServiceUrls, err} = await go(
        this._getDubboServiceUrls(dubboServicePath, dubboInterface),
      );

      // when getChildren had occur error
      if (err) {
        log(`getChildren ${dubboServicePath} error ${err}`);
        traceErr(err);
        return;
      }

      //clear current dubbo interface
      const agentAddrList = [];
      const urls = [];
      for (let serviceUrl of dubboServiceUrls) {
        const url = DubboUrl.from(serviceUrl);
        const {host, port} = url;
        agentAddrList.push(`${host}:${port}`);
        urls.push(url);
      }

      this._createConsumer({
        name: this._props.application.name,
        dubboInterface: dubboInterface,
      }).then(() => log('create consumer finish'));

      this._dubboServiceUrlMap.set(dubboInterface, urls);

      if (agentAddrList.length === 0) {
        traceErr(new Error(`trigger watch ${e} agentList is empty`));
      }

      if (isDevEnv) {
        log('agentSet:|> %O', this._allAgentAddrSet);
        log(
          'update dubboInterface %s providerList %O',
          dubboInterface,
          this._dubboServiceUrlMap.get(dubboInterface),
        );
      }

      if (!eqSet(this._agentAddrSet, this._allAgentAddrSet)) {
        this._agentAddrSet = this._allAgentAddrSet;
        this._subscriber.onData(this._allAgentAddrSet);
      } else {
        log('no agent change');
      }
    };
  }

  private _getChildren = (
    path: string,
    watch: (e: zookeeper.Event) => void,
  ): Promise<{children: Array<string>; stat: zookeeper.Stat}> => {
    return new Promise((resolve, reject) => {
      this._client.getChildren(path, watch, (err, children, stat) => {
        if (err) {
          reject(err);
          return;
        }

        resolve({
          children,
          stat,
        });
      });
    });
  };

  /**
   * com.alibaba.dubbo.registry.zookeeper.ZookeeperRegistry
   */
  private async _createConsumer(params: ICreateConsumerParam) {
    let {name, dubboInterface} = params;

    const dubboSetting = this._props.dubboSetting.getDubboSetting(
      dubboInterface,
    );

    if (!dubboSetting) {
      throw new Error(
        `Could not find group, version for ${dubboInterface} please check your dubbo setting`,
      );
    }

    const queryParams = {
      interface: dubboInterface,
      application: name,
      category: 'consumers',
      method: '',
      revision: '',
      version: dubboSetting.version,
      group: dubboSetting.group,
      side: 'consumer',
      check: 'false',
    };

    //create root comsumer
    const consumerRoot = `/${this._props.zkRoot}/${dubboInterface}/consumers`;
    const err = await this._createRootConsumer(consumerRoot);
    if (err) {
      log('create root consumer: error %o', err);
      return;
    }

    //create comsumer
    const consumerUrl =
      consumerRoot +
      '/' +
      encodeURIComponent(
        `consumer://${ipAddress}/${dubboInterface}?${qs.stringify(
          queryParams,
        )}`,
      );
    const exist = await go(this._exists(consumerUrl));
    if (exist.err) {
      log(`check consumer url: ${decodeURIComponent(consumerUrl)} failed`);
      return;
    }

    if (exist.res) {
      log(
        `check consumer url: ${decodeURIComponent(consumerUrl)} was existed.`,
      );
      return;
    }

    const create = await go(
      this._create(consumerUrl, zookeeper.CreateMode.EPHEMERAL),
    );

    if (create.err) {
      log(
        `check consumer url: ${decodeURIComponent(
          consumerUrl,
        )}创建consumer失败 %o`,
        create.err,
      );
      return;
    }

    log(`create successfully consumer url: ${decodeURIComponent(consumerUrl)}`);
  }

  private async _createRootConsumer(consumer: string) {
    let {res, err} = await go(this._exists(consumer));
    //check error
    if (err) {
      return err;
    }

    // current consumer root path was existed.
    if (res) {
      return null;
    }

    //create current consumer path
    ({err} = await go(this._create(consumer, zookeeper.CreateMode.PERSISTENT)));
    if (err) {
      return err;
    }

    log('create root comsumer %s successfull', consumer);
  }

  private _create = (path: string, mode: number): Promise<string> => {
    return new Promise((resolve, rejec) => {
      this._client.create(path, mode, (err, path) => {
        if (err) {
          rejec(err);
          return;
        }
        resolve(path);
      });
    });
  };

  private _exists = (path: string): Promise<zookeeper.Stat> => {
    return new Promise((resolve, reject) => {
      this._client.exists(path, (err, stat) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stat);
      });
    });
  };
}

export default function Zk(props: IZkClientProps) {
  return (dubboProps: IDubboRegistryProps) =>
    new ZkRegistry({
      ...props,
      ...dubboProps,
    });
}
