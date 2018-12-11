import React from 'react';
import { connect } from 'react-redux';
import { trytesToAscii } from '@iota/converter';
import { createHttpClient } from '@iota/http-client'
import styled from 'styled-components';
import { createContext, Reader, Mode } from 'mam.client.js/lib/mam';
import isEmpty from 'lodash-es/isEmpty';
import { loadUser } from '../store/user/actions';
import { loadSensor } from '../store/sensor/actions';
import { userAuth } from '../utils/firebase';
import { getData, getBalance } from '../utils/iota';
import SensorNav from '../components/sensor-nav';
import Modal from '../components/modal/purchase';
import Sidebar from '../components/side-bar';
import DataStream from '../components/data-stream';
import api from '../utils/api';

class Sensor extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      packets: [],
      purchase: false,
      button: true,
      index: 0,
      loading: {
        heading: 'Loading Device',
        body: 'Fetching device information and your purchase history.',
      },
      error: false,
      fetching: false,
    };

    this.fetch = this.fetch.bind(this);
    this.fetchMam = this.fetchMam.bind(this);
    this.fetchWallet = this.fetchWallet.bind(this);
    this.fund = this.fund.bind(this);
    this.loadMore = this.loadMore.bind(this);
    this.purchase = this.purchase.bind(this);
    this.saveData = this.saveData.bind(this);
    this.throw = this.throw.bind(this);
  }

  async componentDidMount() {
    const userId = (await userAuth()).uid;
    const {
      match: {
        params: { deviceId },
      },
      settings: { provider }
    } = this.props;

    // Init Wallet
    this.fetchWallet(userId);

    await this.props.loadSensor(deviceId);

    // Get data
    const device = this.props.sensor;

    if (device.address) {
      device.balance = await getBalance(device.address, provider);
    }

    if (typeof device === 'string') {
      return this.throw({
        body: `The device you are looking for doesn't exist, check the device ID and try again`,
        heading: `Device doesn't exist`,
      });
    }

    // Organise data for layout
    const layout = [];
    device.dataTypes.forEach((item, i) => {
      if (!layout[Math.floor(i / 2)]) {
        layout[Math.floor(i / 2)] = [];
      }
      layout[Math.floor(i / 2)].push(item);
    });

    this.setState({
      layout,
      userId,
    });
    // MAM
    this.fetch(userId);
  }

  throw(error, button) {
    this.setState({
      loading: false,
      error,
      button,
    });
  }

  async fetch(userId) {
    const {
      match: {
        params: { deviceId },
      },
    } = this.props;

    let data = await getData(userId, deviceId);
    if (typeof data === 'string') {
      if (data === 'No data to return') {
        return this.setState({ loading: false, purchase: true });
      }
      return this.setState({ loading: false });
    }

    if (data && data[0].time) {
      data = data.sort((a, b) => b.time - a.time);
    } else {
      return this.throw({
        body: 'Device data does not exist or is in an unrecognisable format.',
        heading: `Stream Read Failure`,
      });
    }
    console.log(data.length + ' Packets found.');
    this.setState({ mamData: data, streamLength: data.length });
    this.fetchMam(data);
  }

  async fetchMam(data) {
    try {
      if (!data[0]) {
        this.throw({
          body: 'Fail',
          heading: 'Fail',
        });
      }

      const ctx = await createContext();
      const client = createHttpClient({ provider: this.props.settings.provider });
      data.splice(this.state.index, 10).map(async ({ root, sidekey }, i) => {
        try {
          const reader = new Reader(ctx, client, Mode.Old, root, sidekey);
          const message = await reader.next();
          if (message && message.value && message.value[0] && message.value[0].message) {
            this.saveData(JSON.parse(trytesToAscii(message.value[0].message.payload)), i);
          }
        } catch (error) {
          console.error('fetchMam error 1', error);
          this.throw({
            body: 'Unable to read the packets of data from the device.',
            heading: 'Device Misconfigured',
          });
        }
      });
    } catch (error) {
      console.error('fetchMam error 2', error);
      this.setState({ dataEnd: true });
    }
  }

  saveData(packet, i) {
    const packets = [...this.state.packets, packet];
    this.setState({
      packets,
      purchase: true,
      fetching: false,
      index: i,
    });
  }

  async fetchWallet(userId) {
    await this.props.loadUser(userId);
    const wallet = this.props.user.wallet;
    if (isEmpty(wallet) || !wallet.balance) {
      this.setState({ desc: 'Wallet not funded', walletLoading: false });
    } else {
      this.setState({
        desc: 'IOTA wallet balance:',
        walletLoading: false,
        error: false,
      });
    }
  }

  async fund() {
    const { userId } = this.state;
    this.setState({ desc: 'Funding wallet', walletLoading: true }, async () => {
      await api('setWallet', { userId });
      this.fetchWallet(userId);
    });
  }

  async purchase() {
    const { userId } = this.state;
    const {
      loadUser,
      user,
      sensor,
      match: {
        params: { deviceId },
      },
    } = this.props;

    if (!user) {
      await loadUser(userId);
    }

    // Make sure we have wallet
    const wallet = user.wallet;
    if (!wallet || isEmpty(wallet) || wallet.error) {
      return this.throw(
        {
          body: 'Setup wallet by clicking the top right, to get a prefunded IOTA wallet.',
          heading: 'Wallet does not exist',
        },
        false
      );
    }
    if (Number(wallet.balance) < Number(sensor.price))
      return this.throw({
        body: 'You have run out of IOTA. Click below to refill you wallet with IOTA.',
        heading: 'Not enough Balance',
      });

    this.setState(
      {
        loading: {
          heading: 'Purchasing Stream',
          body: 'You are doing Proof of Work to attach this purchase to the network.',
        },
      },
      async () => {
        // Try purchase
        let purchaseResp;
        try {
          const purchaseDataPacket = {
            userId,
            address: sensor.address,
            value: Number(sensor.price),
          };

          const purchaseDataResult = await api('purchaseData', purchaseDataPacket);
          if (purchaseDataResult && purchaseDataResult.transactions) {
            purchaseResp = purchaseDataResult.transactions;
          }
        } catch (error) {
          console.error('purchase error', error);
          return this.throw({
            body: error.message,
            heading: 'Purchase Failed',
          });
        }
        this.setState(
          {
            loading: {
              heading: 'Success!',
              body: 'Your purchase was successful. Fetching MAM stream and decoding data.',
            },
          },
          async () => {
            const packet = {
              userId,
              deviceId,
              full: true,
              hashes: purchaseResp && purchaseResp.map(bundle => bundle.hash),
            };

            const balanceUpdateResponse = await api('updateBalance', { userId, deviceId });
            await loadUser(userId);

            if (balanceUpdateResponse.success) {
              const message = await api('purchaseStream', packet);
              // Check Success
              if (message.success) {
                // Start Fetching data
                this.fetch(userId);
                // Update wallet balance
                return this.setState({
                  loading: true,
                  purchase: true,
                });
              } else {
                return this.throw({
                  body: message.error,
                  heading: 'Purchase Failed',
                });
              }
            } else {
              return this.throw({
                body: balanceUpdateResponse.error,
                heading: 'Purchase Failed',
              });
            }
          }
        );
      }
    );
  }

  loadMore() {
    if (this.state.packets[0] && !this.state.fetching) {
      this.setState({ fetching: true }, () => {
        this.fetchMam(this.state.mamData);
      });
    }
  }

  render() {
    const { purchase, loading, error, button } = this.state;
    const { sensor, user } = this.props;
    return (
      <Main>
        <SensorNav {...this.state} device={sensor} wallet={user.wallet || {}} fund={this.fund} />
        <Data>
          <Sidebar {...this.state} device={sensor} />
          <DataStream {...this.state} func={this.loadMore} />
        </Data>
        <Modal
          device={sensor}
          button={button}
          purchase={this.purchase}
          show={!purchase}
          loading={loading}
          error={error}
        />
      </Main>
    );
  }
}

const mapStateToProps = state => ({
  sensor: state.sensor,
  settings: state.settings,
  user: state.user,
});

const mapDispatchToProps = dispatch => ({
  loadSensor: deviceId => dispatch(loadSensor(deviceId)),
  loadUser: userId => dispatch(loadUser(userId)),
});

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(Sensor);

const Main = styled.main`
  width: 100vw;
  height: 100vh;
`;

const Data = styled.section`
  background-image: linear-gradient(-189deg, #06236c 1%, #1449c6 95%);
  min-height: 90vh;
  position: relative;
  display: flex;
  @media (max-width: 760px) {
    flex-direction: column;
  }
`;
